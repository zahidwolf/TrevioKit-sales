import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { recordedBalance, retailerTotals } from '../lib/balance';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, scryptSync, randomBytes, randomUUID } from 'node:crypto';
let repl: MongoMemoryReplSet, client: MongoClient, server: ChildProcess;
const origin = 'http://localhost:3108'; const secret = randomBytes(32).toString('hex'); const password = 'Test-only-password-123!';
let cookie = '';
async function post(path: string, data: unknown = {}, session = cookie, requestOrigin = origin) { return fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin, Cookie: session }, body: JSON.stringify(data) }); }
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.15' } });
  client = await new MongoClient(repl.getUri()).connect(); const salt = randomBytes(16).toString('hex');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3108'], { env: { ...process.env, MONGODB_URI: repl.getUri(), MONGODB_DB: 'http_test', OWNER_USERNAME: 'owner', OWNER_PASSWORD_HASH: salt + ':' + scryptSync(password, salt, 64).toString('hex'), SESSION_SECRET: secret, APP_ORIGIN: origin }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const res = await fetch(origin + '/login'); if (res.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Test application did not start');
});
afterAll(async () => { server?.kill(); if (server && server.exitCode === null) await new Promise<void>(resolve => { server.once('exit', () => resolve()); setTimeout(resolve, 5000); }); await client?.close(); await repl?.stop(); });
describe('production HTTP access boundaries', () => {
  it('protects and validates the dashboard period endpoint', async () => {
    expect((await fetch(origin + '/api/data?collection=dashboard&period=all')).status).toBe(401);
    expect((await fetch(origin + '/api/data?collection=analysis&period=all')).status).toBe(401);
  });

  it('redirects anonymous business page and rejects protected APIs', async () => { const res = await fetch(origin, { redirect: 'manual' }); expect(res.status).toBe(307); expect(res.headers.get('location')).toBe('/login'); expect((await fetch(origin + '/api/data')).status).toBe(401); expect((await post('/api/operations', {}, '')).status).toBe(401); expect((await post('/api/auth/logout', {}, '')).status).toBe(401); });
  it('rejects cross-origin login and invalid credentials', async () => { expect((await post('/api/auth/login', { username: 'owner', password }, '', 'https://attacker.example')).status).toBe(403); expect((await post('/api/auth/login', { username: 'owner', password: 'wrong' }, '')).status).toBe(401); });
  it('issues secure cookies and allows authenticated reads', async () => { const res = await post('/api/auth/login', { username: 'owner', password }, ''); expect(res.status).toBe(200); const header = res.headers.get('set-cookie')!; expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header.toLowerCase()).toContain('samesite=strict'); cookie = header.split(';')[0]; expect((await fetch(origin + '/api/data', { headers: { Cookie: cookie } })).status).toBe(200); });

  it('returns dashboard period totals and validates custom ranges over HTTP', async () => {
    const headers = { Cookie: cookie };
    const all = await fetch(origin + '/api/data?collection=dashboard&period=all', { headers });
    expect(all.status).toBe(200);
    expect(await all.json()).toMatchObject({ invoices: [], history: [], net: 0 });
    const future = await fetch(origin + '/api/data?collection=dashboard&period=custom&startDate=3000-01-01&endDate=3000-01-02', { headers });
    expect(future.status).toBe(200);
    expect(await future.json()).toMatchObject({ invoices: [], history: [], net: 0 });
    expect((await fetch(origin + '/api/data?collection=dashboard&period=custom&startDate=2026-10-05&endDate=2026-10-01', { headers })).status).toBe(400);
    const analysis = await fetch(origin + '/api/data?collection=analysis&period=all', { headers });
    expect(analysis.status).toBe(200);
    expect(await analysis.json()).toMatchObject({ net: 0, paid: 0, expenses: 0, afterExpenses: 0, products: [], retailers: [], expenseChart: [] });
    expect((await fetch(origin + '/api/data?collection=analysis&period=custom&startDate=2026-02-30&endDate=2026-03-01', { headers })).status).toBe(400);
  });
  it('rejects CSRF mutations even with a valid session', async () => { expect((await post('/api/operations', {}, cookie, 'https://attacker.example')).status).toBe(403); expect((await post('/api/auth/logout', {}, cookie, 'https://attacker.example')).status).toBe(403); });
  it('completes the HTTP exchange workflow and reports correct dashboard/retailer totals', async () => {
    async function operation(payload: unknown, key = randomUUID()) {
      const res = await fetch(origin + '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      expect(res.status).toBe(200); return res.json();
    }
    const product = await operation({ type: 'product', name: 'HTTP Jersey', size: 'L', unitPrice: 100000, imageUrl: '', active: true });
    const retailer = await operation({ type: 'retailer', name: 'HTTP Retailer', phone: '01700000000', shopName: '', address: '', active: true });
    await operation({ type: 'stock', productId: product.id, delta: 20, reason: 'Test stock' });
    const purchase = await operation({ type: 'sale', retailerId: retailer.id, lines: [{ productId: product.id, quantity: 2, unitPrice: 100000 }], note: '' });
    const exchange = { type: 'return', retailerId: retailer.id, invoiceId: purchase.invoiceId, lines: [{ productId: product.id, quantity: 2 }], exchangeLines: [{ productId: product.id, quantity: 7, unitPrice: 100000 }], reason: 'Test exchange', paidAmount: 300000 };
    const invalid = await fetch(origin + '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...exchange, reason: '' }) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('Return reason is required.');
    const unchanged = await (await fetch(origin + '/api/data', { headers: { Cookie: cookie } })).json();
    expect(unchanged.products[0].stock).toBe(18);
    expect(unchanged.invoices).toHaveLength(1);
    const key = randomUUID(); const result = await operation(exchange, key); const repeat = await operation(exchange, key); expect(result).toEqual(repeat);
    const data = await (await fetch(origin + '/api/data', { headers: { Cookie: cookie } })).json();
    expect(data.products[0].stock).toBe(13); expect(data.invoices).toHaveLength(2);
    expect(retailerTotals(data.invoices)).toMatchObject({ orders: 2, sold: 9, returned: 2, net: 700000 });
    expect(data.invoices.find((b: { _id: string }) => b._id === result.invoiceId)).toMatchObject({ total: 500000, paidAmount: 300000, dueAmount: 200000 });
    const history = await (await fetch(origin + '/api/data?collection=invoices&retailerId=' + retailer.id, { headers: { Cookie: cookie } })).json();
    expect(recordedBalance(history)).toEqual({ balance: 200000, due: 200000, credit: 0, unrecorded: 1 });
    await operation({ type: 'return', retailerId: retailer.id, invoiceId: result.invoiceId, lines: [{ productId: product.id, quantity: 1 }], reason: 'Reduce outstanding due', paidAmount: 0 });
    const updatedHistory = await (await fetch(origin + '/api/data?collection=invoices&retailerId=' + retailer.id, { headers: { Cookie: cookie } })).json();
    expect(recordedBalance(updatedHistory)).toEqual({ balance: 100000, due: 100000, credit: 0, unrecorded: 1 });
    expect(updatedHistory.find((b: { _id: string }) => b._id === result.invoiceId)).toMatchObject({ dueAmount: 200000 });
    const cleared = await operation({ type: 'sale', retailerId: retailer.id, lines: [{ productId: product.id, quantity: 1, unitPrice: 100000 }], note: '', paidAmount: 200000, expectedBalance: 100000 });
    const clearedHistory = await (await fetch(origin + '/api/data?collection=invoices&retailerId=' + retailer.id, { headers: { Cookie: cookie } })).json();
    expect(recordedBalance(clearedHistory).due).toBe(0);
    expect(clearedHistory.find((b: { _id: string }) => b._id === cleared.invoiceId)).toMatchObject({ openingBalance: 100000, totalPayable: 200000, paidAmount: 200000, balanceAfter: 0, dueAmount: 0 });
    expect(clearedHistory.find((b: { _id: string }) => b._id === result.invoiceId)).toMatchObject({ dueAmount: 200000, paidAmount: 300000, currentRetailerDue: 0 });
    // A filter matching only the old invoice still uses complete retailer history.
    const oldInvoice = updatedHistory.find((b: { _id: string }) => b._id === result.invoiceId);
    const filtered = await (await fetch(origin + '/api/data?collection=invoices&search=' + encodeURIComponent(oldInvoice.number), { headers: { Cookie: cookie } })).json();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ currentRetailerDue: 0, dueAmount: 200000 });
    const dashboard = await (await fetch(origin + '/api/data?collection=dashboard&period=all', { headers: { Cookie: cookie } })).json();
    expect(dashboard.invoices.find((b: { _id: string }) => b._id === result.invoiceId).currentRetailerDue).toBe(0);

  });
  it('protects expense history and saves validated expenses exactly once', async () => {
    expect((await fetch(origin + '/api/data?collection=expenses')).status).toBe(401);
    const expense = { type: 'expense', description: 'Packaging', amount: 12345, expenseDate: '2026-10-05' };
    const key = randomUUID();
    const send = (payload: unknown) => fetch(origin + '/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'Idempotency-Key': key }, body: JSON.stringify(payload) });
    expect((await send({ ...expense, expenseDate: '2026-02-30' })).status).toBe(400);
    const responses = await Promise.all([send(expense), send(expense)]);
    for (const response of responses) expect(response.status).toBe(200);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    const result = await fetch(origin + '/api/data?collection=expenses', { headers: { Cookie: cookie } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ total: 12345, count: 1, expenses: [{ description: 'Packaging', amount: 12345, expenseDate: '2026-10-05' }] });
    const headers = { Cookie: cookie };
    const included = await fetch(origin + '/api/data?collection=expenses&period=custom&startDate=2026-10-05&endDate=2026-10-05', { headers });
    expect(await included.json()).toMatchObject({ total: 12345, count: 1 });
    const excluded = await fetch(origin + '/api/data?collection=expenses&period=custom&startDate=2026-10-06&endDate=2026-10-10', { headers });
    expect(await excluded.json()).toEqual({ expenses: [], total: 0, count: 0 });
    const older = await fetch(origin + '/api/data?collection=expenses&period=custom&startDate=2026-10-05&endDate=2026-10-05&offset=100', { headers });
    expect(await older.json()).toEqual({ expenses: [], total: 12345, count: 1 });
    expect((await fetch(origin + '/api/data?collection=expenses&period=custom&startDate=2026-10-10&endDate=2026-10-05', { headers })).status).toBe(400);
  });
  it('revokes the current session on logout', async () => { expect((await post('/api/auth/logout')).status).toBe(200); expect((await fetch(origin + '/api/data', { headers: { Cookie: cookie } })).status).toBe(401); });
  it('rejects expired sessions before TTL cleanup', async () => { const token = randomBytes(32).toString('hex'); const hash = createHmac('sha256', secret).update(token).digest('hex'); await client.db('http_test').collection<{ _id: string; expiresAt: Date }>('sessions').insertOne({ _id: hash, expiresAt: new Date(Date.now() - 1000) }); expect((await fetch(origin + '/api/data', { headers: { Cookie: 'treviokit_session=' + token } })).status).toBe(401); });
  it('rate-limits login across requests in persistent storage', async () => { let last = 0; for (let i = 0; i < 12; i++) last = (await post('/api/auth/login', { username: 'owner', password: 'wrong' }, '')).status; expect(last).toBe(429); });
});
