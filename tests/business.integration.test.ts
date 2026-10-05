import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { recordedBalance } from '../lib/balance';
import { invoiceQuery } from '../lib/invoice-filters';
import { dashboardQuery } from '../lib/dashboard-filters';
import { dashboardStats } from '../lib/dashboard-stats';
import { analysisStats } from '../lib/analysis-stats';
import { expenseQuery } from '../lib/expense-filters';
import { execute, type Product, type Invoice } from '../lib/business';
let repl: MongoMemoryReplSet, client: MongoClient, db: Db, productId: string, retailerId: string;
const run = (op: unknown, key = randomUUID()) => execute(db, client, key, op);
const sale = (quantity: number, product = productId, unitPrice = 100000) => ({ type: 'sale', retailerId, lines: [{ productId: product, quantity, unitPrice }], note: '' });
const stock = () => db.collection<Product>('products').findOne({ _id: productId });
const ret = (invoiceId: string, quantity: number, exchangeLines?: unknown[]) => ({ type: 'return', retailerId, invoiceId, lines: [{ productId, quantity }], reason: 'Size exchange', ...(exchangeLines ? { exchangeLines } : {}) });
beforeAll(async () => { repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.0.15' } }); client = await new MongoClient(repl.getUri()).connect(); db = client.db('test'); });
afterAll(async () => { await client?.close(); await repl?.stop(); });
beforeEach(async () => {
  await db.dropDatabase(); await db.collection('invoices').createIndex({ number: 1 }, { unique: true }); await db.collection('products').createIndex({ nameKey: 1, sizeKey: 1 }, { unique: true });
  productId = (await run({ type: 'product', name: 'Jersey', size: 'L', unitPrice: 100000, imageUrl: '', active: true }))!.id;
  retailerId = (await run({ type: 'retailer', name: 'Retailer', phone: '01700000000', shopName: 'Shop', address: '', active: true }))!.id;
  await run({ type: 'stock', productId, delta: 20, reason: 'Opening stock' });
});
describe('real replica-set transaction invariants', () => {
  it('analyzes sale and exchange lines once and filters backdated expenses independently', async () => {
    const purchase = await run({ ...sale(3), paidAmount: 200000 });
    await run({ ...ret(purchase!.id, 1, [{ productId, quantity: 2, unitPrice: 100000 }]), paidAmount: 150000 });
    await run({ type: 'expense', description: 'Rent', amount: 12345, expenseDate: '2000-01-01' });
    const all = await analysisStats(db, {}, {}, true);
    expect(all).toMatchObject({ net: 400000, paid: 350000, expenses: 12345, expenseCount: 1, afterExpenses: 387655, unitsSold: 5, unitsReturned: 1, due: 50000 });
    expect(all.products).toEqual([{ _id: productId, name: 'Jersey', size: 'L', sold: 5, returned: 1, net: 400000 }]);
    expect(all.retailers).toEqual([{ _id: retailerId, name: 'Shop', transactions: 2, sold: 5, returned: 1, net: 400000, paid: 350000 }]);
    expect(all.expenseChart).toEqual([{ _id: '2000-01', amount: 12345 }]);
    const range = new URLSearchParams('period=custom&startDate=2000-01-01&endDate=2000-01-01');
    const filtered = await analysisStats(db, dashboardQuery(range), expenseQuery(range), false);
    expect(filtered).toMatchObject({ net: 0, paid: 0, expenses: 12345, afterExpenses: -12345, due: 50000, products: [], retailers: [], expenseChart: [{ _id: '2000-01-01', amount: 12345 }] });
  });
  it('records expenses and audit history once for concurrent duplicate submissions', async () => {
    const expense = { type: 'expense', description: 'Shop rent', amount: 12345, expenseDate: '2026-10-05' };
    const key = randomUUID();
    const results = await Promise.all([run(expense, key), run(expense, key), run(expense, key)]);
    expect(new Set(results.map(result => result!.id)).size).toBe(1);
    expect(await db.collection('expenses').countDocuments()).toBe(1);
    expect(await db.collection('expenses').findOne()).toMatchObject({ description: 'Shop rent', amount: 12345, expenseDate: '2026-10-05' });
    expect(await db.collection('history').countDocuments({ type: 'expense' })).toBe(1);
    expect(await db.collection<{ _id: string }>('submissions').countDocuments({ _id: key })).toBe(1);
    expect((await stock())!.stock).toBe(20);
    expect(await db.collection('invoices').countDocuments()).toBe(0);
    await expect(run({ ...expense, amount: 0 })).rejects.toThrow();
    await expect(run({ ...expense, amount: 999 }, key)).rejects.toThrow('different data');
    expect(await db.collection('expenses').countDocuments()).toBe(1);
  });
  it('calculates dashboard revenue, payments, units and current due without duplicating historical dues', async () => {
    const purchase = await run({ ...sale(1), paidAmount: 0 });
    await run({ ...sale(1), paidAmount: 200000 }); // Pays the old invoice as well.
    await run({ ...ret(purchase!.id, 1), paidAmount: 0 }); // Creates retailer credit.
    const other = (await run({ type: 'retailer', name: 'Other retailer', phone: '01700000001', shopName: 'Other shop', address: '', active: true }))!.id;
    await run({ ...sale(1), retailerId: other, paidAmount: 0 });
    await run(sale(1)); // Legacy payment-unrecorded invoice must not invent a due.
    const stats = await dashboardStats(db, {}, false);
    expect(stats).toMatchObject({ net: 300000, paid: 200000, unitsSold: 4, unitsReturned: 1, due: 100000, credit: 100000, unrecorded: 1 });
    expect(stats.chart).toHaveLength(1);
    expect(stats.chart[0]).toMatchObject({ revenue: 300000, paid: 200000, sold: 4, returned: 1 });
    const monthly = await dashboardStats(db, {}, true);
    expect(monthly.chart[0]._id).toMatch(/^\d{4}-\d{2}$/);
    const emptyPeriod = await dashboardStats(db, { createdAt: { $gte: new Date('3000-01-01') } }, false);
    expect(emptyPeriod).toMatchObject({ net: 0, paid: 0, unitsSold: 0, unitsReturned: 0, due: 100000, credit: 100000, chart: [] });
  });

  it('combines retailer, Dhaka dates and search before pagination', async () => {
    const fixtures = Array.from({ length: 104 }, (_, n) => ({ _id: randomUUID(), number: `FILTER-${n}`, retailerId: n === 103 ? randomUUID() : retailerId, retailer: { _id: retailerId, name: 'Retailer', phone: '', shopName: '', address: '', active: true }, lines: [], total: 10000, note: '', createdAt: new Date(n === 102 ? '2026-10-05T18:00:00Z' : n === 101 ? '2026-10-04T17:59:59Z' : '2026-10-05T12:00:00Z'), ...(n === 100 ? {} : { paidAmount: n === 99 ? 10000 : 5000, dueAmount: n === 99 ? 0 : 5000 }) }));
    await db.collection<Invoice>('invoices').insertMany(fixtures);
    const range = dashboardQuery(new URLSearchParams({ period: 'today' }), new Date('2026-10-05T12:00:00Z'));
    const totals = await db.collection<Invoice>('invoices').aggregate([{ $match: range }, { $group: { _id: null, net: { $sum: '$total' } } }]).toArray();
    expect(totals[0].net).toBe(1020000); // All 102 matching records, beyond a page of 100.
    expect(await db.collection<Invoice>('invoices').countDocuments(dashboardQuery(new URLSearchParams({ period: 'all' })))).toBe(104);

    const params = new URLSearchParams({ retailerId, startDate: '2026-10-05', endDate: '2026-10-05' });
    const query = invoiceQuery(params);
    expect(await db.collection<Invoice>('invoices').countDocuments(query)).toBe(101);
    params.set('search', 'filter-98');
    expect(await db.collection<Invoice>('invoices').find(invoiceQuery(params)).toArray()).toMatchObject([{ number: 'FILTER-98' }]);
    params.set('search', 'Retailer');
    expect(await db.collection<Invoice>('invoices').countDocuments(invoiceQuery(params))).toBe(101);
    params.set('search', 'FILTER-.*');
    expect(await db.collection<Invoice>('invoices').countDocuments(invoiceQuery(params))).toBe(0);
    params.delete('search');
    expect(await db.collection<Invoice>('invoices').find(query).skip(100).limit(100).toArray()).toHaveLength(1);

  });

  it('uses short sequential numbers for sales, returns, and exchanges with original references', async () => {
    const purchase = await run(sale(4));
    const returned = await run(ret(purchase!.id, 1));
    const exchanged = await run(ret(purchase!.id, 1, [{ productId, quantity: 1, unitPrice: 100000 }]));
    expect(await db.collection<Invoice>('invoices').findOne({ _id: purchase!.id })).toMatchObject({ number: 'TK-000001' });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: returned!.invoiceId })).toMatchObject({ number: 'TK-000002', originalInvoiceNumber: 'TK-000001' });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: exchanged!.invoiceId })).toMatchObject({ number: 'TK-000003', originalInvoiceNumber: 'TK-000001' });
  });
  it('allocates unique numbers for concurrent first-use requests from different retailers', async () => {
    const other = (await run({ type: 'retailer', name: 'Second', phone: '01700000001', shopName: 'Other', address: '', active: true }))!.id;
    await Promise.all([run(sale(1)), run({ ...sale(1), retailerId: other })]);
    const invoices = await db.collection<Invoice>('invoices').find().toArray();
    expect(invoices.map(i => i.number).sort()).toEqual(['TK-000001', 'TK-000002']);
  });
  it('does not allocate extra invoice numbers for duplicate or failed submissions', async () => {
    const key = randomUUID();
    await Promise.all([run(sale(1), key), run(sale(1), key)]);
    await expect(run({ ...sale(1), paidAmount: 200000 })).rejects.toThrow();
    await run(sale(1));
    expect((await db.collection<Invoice>('invoices').find().toArray()).map(i => i.number).sort()).toEqual(['TK-000001', 'TK-000002']);
  });

  it('clears previous due together with the new exchange and preserves issued invoice amounts', async () => {
    const old = await run({ ...sale(1, productId, 75000), paidAmount: 0 });
    const key = randomUUID();
    const op = { ...ret(old!.id, 1, [{ productId, quantity: 3, unitPrice: 75000 }]), paidAmount: 225000, expectedBalance: 75000 };
    const results = await Promise.all([run(op, key), run(op, key)]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.collection<Invoice>('invoices').findOne({ _id: results[0]!.invoiceId })).toMatchObject({ total: 150000, openingBalance: 75000, totalPayable: 225000, paidAmount: 225000, dueAmount: 0, balanceAfter: 0 });
    expect(recordedBalance(await db.collection<Invoice>('invoices').find().toArray()).due).toBe(0);
    expect(await db.collection<Invoice>('invoices').findOne({ _id: old!.id })).toMatchObject({ total: 75000, paidAmount: 0, dueAmount: 75000 });
    expect((await stock())!.stock).toBe(17);
  });
  it('carries a partial combined payment forward and clears it on a later sale', async () => {
    await run({ ...sale(1, productId, 75000), paidAmount: 0 });
    const partial = await run({ ...sale(2, productId, 75000), paidAmount: 125000 });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: partial!.id })).toMatchObject({ totalPayable: 225000, dueAmount: 100000 });
    await run({ ...sale(1, productId, 75000), paidAmount: 175000, expectedBalance: 100000 });
    expect(recordedBalance(await db.collection<Invoice>('invoices').find().toArray()).balance).toBe(0);
  });
  it('serializes simultaneous checkouts for different products so previous due cannot be collected twice', async () => {
    await run({ ...sale(1, productId, 75000), paidAmount: 0 });
    const a = await run({ type: 'product', name: 'Other A', size: 'M', initialStock: 10, unitPrice: 150000, imageUrl: '', active: true });
    const b = await run({ type: 'product', name: 'Other B', size: 'M', initialStock: 10, unitPrice: 150000, imageUrl: '', active: true });
    const results = await Promise.allSettled([run({ ...sale(1, a!.id, 150000), paidAmount: 225000, expectedBalance: 75000 }), run({ ...sale(1, b!.id, 150000), paidAmount: 225000, expectedBalance: 75000 })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.collection('invoices').countDocuments()).toBe(2);
    const quantities = await db.collection<Product>('products').find({ _id: { $in: [a!.id, b!.id] } }).toArray();
    expect(quantities.map(p => p.stock).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(recordedBalance(await db.collection<Invoice>('invoices').find().toArray()).due).toBe(0);
  });
  it('uses previous return credits in total payable and permits collection on a return with remaining debt', async () => {
    const old = await run({ ...sale(2), paidAmount: 0 });
    const returned = await run({ ...ret(old!.id, 1), paidAmount: 100000 });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: returned!.invoiceId })).toMatchObject({ total: -100000, totalPayable: 100000, dueAmount: 0 });
    expect(recordedBalance(await db.collection<Invoice>('invoices').find().toArray()).due).toBe(0);
    await run({ ...ret(old!.id, 1), paidAmount: 0 });
    const next = await run({ ...sale(2), paidAmount: 100000 });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: next!.id })).toMatchObject({ openingBalance: -100000, totalPayable: 100000, dueAmount: 0 });
    expect(recordedBalance(await db.collection<Invoice>('invoices').find().toArray()).balance).toBe(0);
  });

  it('records partial payment and due atomically with the sale', async () => {
    const result = await run({ ...sale(9), paidAmount: 500000 });
    const bill = await db.collection<Invoice>('invoices').findOne({ _id: result!.id });
    expect(bill).toMatchObject({ total: 900000, paidAmount: 500000, dueAmount: 400000 });
    expect((await stock())!.stock).toBe(11);
  });
  it('supports unpaid and fully paid invoices without inferring old payment status', async () => {
    for (const paidAmount of [0, 200000]) {
      const result = await run({ ...sale(1), paidAmount });
      const bill = await db.collection<Invoice>('invoices').findOne({ _id: result!.id });
      expect(bill).toMatchObject({ paidAmount, dueAmount: paidAmount === 0 ? 100000 : 0 });
    }
    const old = await run(sale(1));
    expect((await db.collection<Invoice>('invoices').findOne({ _id: old!.id }))!.paidAmount).toBeUndefined();
  });
  it('rolls back an overpaid sale and rejects invalid payment units', async () => {
    await expect(run({ ...sale(2), paidAmount: 200001 })).rejects.toThrow('cannot exceed');
    for (const paidAmount of [-1, 0.5]) await expect(run({ ...sale(2), paidAmount })).rejects.toThrow();
    expect((await stock())!.stock).toBe(20);
    expect(await db.collection('invoices').countDocuments()).toBe(0);
  });
  it('bases exchange payment and due on its net value and rolls back overpayment', async () => {
    const purchase = await run({ ...sale(2), paidAmount: 200000 });
    const exchange = ret(purchase!.id, 2, [{ productId, quantity: 7, unitPrice: 100000 }]);
    await expect(run({ ...exchange, paidAmount: 500001 })).rejects.toThrow('cannot exceed');
    expect((await stock())!.stock).toBe(18);
    expect(await db.collection('returns').countDocuments()).toBe(0);
    const key = randomUUID();
    const [first, second] = await Promise.all([run({ ...exchange, paidAmount: 300000 }, key), run({ ...exchange, paidAmount: 300000 }, key)]);
    expect(first).toEqual(second);
    expect(await db.collection('returns').countDocuments()).toBe(1);
    expect(await db.collection<Invoice>('invoices').findOne({ _id: first!.invoiceId })).toMatchObject({ total: 500000, paidAmount: 300000, dueAmount: 200000 });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: purchase!.id })).toMatchObject({ paidAmount: 200000, dueAmount: 0 });
  });
  it('rejects incoming payment on credit/refund transactions', async () => {
    const purchase = await run(sale(2));
    await expect(run({ ...ret(purchase!.id, 1), paidAmount: 1 })).rejects.toThrow('cannot exceed');
    expect((await stock())!.stock).toBe(18);
    expect(await db.collection('returns').countDocuments()).toBe(0);
    const result = await run({ ...ret(purchase!.id, 1), paidAmount: 0 });
    expect(await db.collection<Invoice>('invoices').findOne({ _id: result!.invoiceId })).toMatchObject({ total: -100000, paidAmount: 0, dueAmount: 0 });
  });
  it('creates opening stock exactly once with concurrent duplicate submissions', async () => {
    const key = randomUUID();
    const op = { type: 'product', name: 'Opening quantity', size: 'M', initialStock: 50, unitPrice: 75000, imageUrl: '', active: true };
    const [first, second] = await Promise.all([run(op, key), run(op, key)]);
    expect(first!.id).toBe(second!.id);
    expect((await db.collection<Product>('products').findOne({ _id: first!.id }))!.stock).toBe(50);
    expect(await db.collection('history').countDocuments({ 'detail.result.id': first!.id })).toBe(1);
    await expect(run({ ...op, id: first!.id, initialStock: 999 })).rejects.toThrow();
    expect((await db.collection<Product>('products').findOne({ _id: first!.id }))!.stock).toBe(50);
  });
  it('rejects negative or fractional opening quantities without saving products', async () => {
    for (const initialStock of [-1, 0.5]) await expect(run({ type: 'product', name: 'Invalid opening', size: 'M', initialStock, unitPrice: 75000, imageUrl: '', active: true })).rejects.toThrow();
    expect(await db.collection('products').countDocuments({ name: 'Invalid opening' })).toBe(0);
  });
  it('deducts stock and snapshots product, size and retailer details', async () => { const result = await run(sale(3)); expect((await stock())!.stock).toBe(17); await run({ type: 'product', id: productId, name: 'Renamed', size: 'XL', unitPrice: 120000, imageUrl: '', active: true }); const bill = await db.collection<Invoice>('invoices').findOne({ _id: result!.id }); expect(bill!.lines[0]).toMatchObject({ name: 'Jersey', size: 'L', unitPrice: 100000 }); expect(bill!.retailer.shopName).toBe('Shop'); });
  it('rolls back all stock changes when a later sale line fails', async () => { await expect(run({ ...sale(2), lines: [{ productId, quantity: 2, unitPrice: 100000 }, { productId: randomUUID(), quantity: 1, unitPrice: 100 }] })).rejects.toThrow(); expect((await stock())!.stock).toBe(20); expect(await db.collection('invoices').countDocuments()).toBe(0); });
  it('prevents simultaneous overselling', async () => { const results = await Promise.allSettled([run(sale(15)), run(sale(15))]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await stock())!.stock).toBe(5); expect(await db.collection('invoices').countDocuments()).toBe(1); });
  it('deduplicates concurrent and sequential submissions and rejects key reuse', async () => { const key = randomUUID(); const results = await Promise.all([run(sale(2), key), run(sale(2), key), run(sale(2), key)]); expect(new Set(results.map(r => r!.id)).size).toBe(1); expect((await stock())!.stock).toBe(18); expect((await run(sale(2), key))!.id).toBe(results[0]!.id); await expect(run(sale(3), key)).rejects.toThrow('different data'); });
  it('credits original price, restores stock and creates a negative return invoice', async () => { const purchase = await run(sale(3)); await run({ type: 'product', id: productId, name: 'Jersey', size: 'L', unitPrice: 120000, imageUrl: '', active: true }); const result = await run(ret(purchase!.id, 2)); expect(result!.netDue).toBe(-200000); expect((await stock())!.stock).toBe(19); const bill = await db.collection<Invoice>('invoices').findOne({ _id: result!.invoiceId }); expect(bill!.total).toBe(-200000); expect(bill!.returnLines![0].unitPrice).toBe(100000); });
  it('produces the requested exchange: 2 returned and 7 taken = ৳5000', async () => { const purchase = await run(sale(2)); const result = await run(ret(purchase!.id, 2, [{ productId, quantity: 7, unitPrice: 100000 }])); expect(result!.netDue).toBe(500000); expect((await stock())!.stock).toBe(13); expect(await db.collection('returns').countDocuments()).toBe(1); const bill = await db.collection<Invoice>('invoices').findOne({ _id: result!.invoiceId }); expect(bill!.total).toBe(500000); expect(bill!.originalInvoiceId).toBe(purchase!.id); });
  it('prevents simultaneous excessive returns', async () => { const purchase = await run(sale(3)); const results = await Promise.allSettled([run(ret(purchase!.id, 2)), run(ret(purchase!.id, 2))]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await stock())!.stock).toBe(19); expect(await db.collection('returns').countDocuments()).toBe(1); });
  it('rolls back return, credit and restock if exchange stock is unavailable', async () => { const purchase = await run(sale(2)); await expect(run(ret(purchase!.id, 2, [{ productId, quantity: 21, unitPrice: 100000 }]))).rejects.toThrow(); expect((await stock())!.stock).toBe(18); expect(await db.collection('returns').countDocuments()).toBe(0); const bill = await db.collection<Invoice>('invoices').findOne({ _id: purchase!.id }); expect(bill!.lines[0].returned).toBe(0); });
  it('deduplicates simultaneous returns', async () => { const purchase = await run(sale(2)); const key = randomUUID(); await Promise.all([run(ret(purchase!.id, 1), key), run(ret(purchase!.id, 1), key)]); expect(await db.collection('returns').countDocuments()).toBe(1); expect((await stock())!.stock).toBe(19); });
  it('keeps each product size separate and prevents duplicate name/size', async () => { const other = await run({ type: 'product', name: 'Jersey', size: 'M', unitPrice: 100000, imageUrl: '', active: true }); expect(other!.id).not.toBe(productId); await expect(run({ type: 'product', name: 'jersey', size: 'l', unitPrice: 100000, imageUrl: '', active: true })).rejects.toThrow(); });
  it('rejects returns against another retailer’s invoice', async () => { const purchase = await run(sale(2)); await expect(run({ ...ret(purchase!.id, 1), retailerId: randomUUID() })).rejects.toThrow('does not belong'); expect((await stock())!.stock).toBe(18); });
  it('prevents stock going negative and archived product sales', async () => { await expect(run({ type: 'stock', productId, delta: -21, reason: 'Incorrect' })).rejects.toThrow(); await run({ type: 'product', id: productId, name: 'Jersey', size: 'L', unitPrice: 100000, imageUrl: '', active: false }); await expect(run(sale(1))).rejects.toThrow(); expect((await stock())!.stock).toBe(20); });
});
