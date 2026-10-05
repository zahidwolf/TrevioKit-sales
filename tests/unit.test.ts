import { describe, expect, it } from 'vitest';
import { operationSchema, validationMessage, parseTaka, total } from '../lib/validation';
import { recordedBalance, retailerTotals, invoicePaymentStatus } from '../lib/balance';
import { randomUUID } from 'node:crypto';
import { invoiceQuery } from '../lib/invoice-filters';
import { dashboardQuery } from '../lib/dashboard-filters';
import { expenseQuery } from '../lib/expense-filters';
describe('Expense date ranges', () => {
  const now = new Date('2026-10-04T20:00:00Z'); // 5 October in Dhaka
  it('uses expense dates and inclusive Dhaka preset ranges', () => {
    expect(expenseQuery(new URLSearchParams(), now)).toEqual({});
    expect(expenseQuery(new URLSearchParams('period=today'), now)).toEqual({ expenseDate: { $gte: '2026-10-05', $lte: '2026-10-05' } });
    expect(expenseQuery(new URLSearchParams('period=7days'), now)).toEqual({ expenseDate: { $gte: '2026-09-29', $lte: '2026-10-05' } });
    expect(expenseQuery(new URLSearchParams('period=30days'), now)).toEqual({ expenseDate: { $gte: '2026-09-06', $lte: '2026-10-05' } });
  });
  it('accepts inclusive custom ranges and rejects invalid dates and ranges', () => {
    expect(expenseQuery(new URLSearchParams('period=custom&startDate=2026-10-01&endDate=2026-10-05'))).toEqual({ expenseDate: { $gte: '2026-10-01', $lte: '2026-10-05' } });
    for (const query of ['period=custom', 'period=custom&startDate=2026-02-30&endDate=2026-03-01', 'period=custom&startDate=2026-10-05&endDate=2026-10-01', 'period=unsupported']) expect(() => expenseQuery(new URLSearchParams(query))).toThrow();
  });
});
describe('Money and input validation', () => {
  it('validates positive expense amounts and real calendar dates', () => {
    const expense = { type: 'expense', description: 'Shop rent', amount: 12345, expenseDate: '2026-10-05' };
    expect(operationSchema.safeParse(expense).success).toBe(true);
    for (const amount of [0, -1, 1.5]) expect(operationSchema.safeParse({ ...expense, amount }).success).toBe(false);
    for (const expenseDate of ['2026-02-29', '2026-13-01', '05/10/2026']) expect(operationSchema.safeParse({ ...expense, expenseDate }).success).toBe(false);
    expect(operationSchema.safeParse({ ...expense, description: '  ' }).success).toBe(false);
  });
  it('explains the missing return reason and invalid line quantity', () => {
    const draft = { type: 'return', retailerId: randomUUID(), invoiceId: randomUUID(), lines: [{ productId: randomUUID(), quantity: 1 }], exchangeLines: [{ productId: randomUUID(), quantity: 3, unitPrice: 75000 }], reason: '  ', paidAmount: 500000 };
    const invalid = operationSchema.safeParse(draft);
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(validationMessage(invalid.error)).toBe('Return reason is required.');
    expect(operationSchema.safeParse({ ...draft, reason: 'Size exchange' }).success).toBe(true);
    const badQuantity = operationSchema.safeParse({ ...draft, reason: 'Size exchange', exchangeLines: [{ ...draft.exchangeLines[0], quantity: 0.5 }] });
    if (!badQuantity.success) expect(validationMessage(badQuantity.error)).toContain('whole quantity');
  });
  it('converts taka into exact integer poisha', () => { expect(parseTaka('1000.01')).toBe(100001); expect(parseTaka('0.1')).toBe(10); expect(parseTaka('0')).toBe(0); });
  it('rejects fractional poisha, negative and ambiguous input', () => { for (const value of ['1.001', '-10', '1e3', 'NaN', '12,000']) expect(() => parseTaka(value)).toThrow(); });
  it('caps totals to avoid overflow', () => { expect(total([{ quantity: 2, unitPrice: 100000 }])).toBe(200000); expect(() => total([{ quantity: 1_000_000, unitPrice: 1_000_000_000_000 }])).toThrow(); });
  it('rejects duplicate lines and fractional quantities', () => { const id = randomUUID(); const base = { type: 'sale', retailerId: randomUUID(), note: '' }; const line = { productId: id, quantity: 1, unitPrice: 100 }; expect(operationSchema.safeParse({ ...base, lines: [line, line] }).success).toBe(false); expect(operationSchema.safeParse({ ...base, lines: [{ ...line, quantity: 0.5 }] }).success).toBe(false); });
  it('only accepts HTTPS image URLs and supported fields', () => { const p = { type: 'product', name: 'Jersey', size: 'L', unitPrice: 10000, imageUrl: '', active: true }; expect(operationSchema.safeParse(p).success).toBe(true); expect(operationSchema.safeParse({ ...p, imageUrl: 'javascript:alert(1)' }).success).toBe(false); expect(operationSchema.safeParse({ ...p, sku: 'unwanted' }).success).toBe(false); });
});

describe('previous retailer due', () => {
  it('shows earlier recorded invoices as paid when current due is cleared without rewriting amounts', () => {
    const invoice = { total: 375000, paidAmount: 300000, dueAmount: 75000, currentRetailerDue: 0 };
    expect(invoicePaymentStatus(invoice)).toEqual({ kind: 'paid', amount: 0 });
    expect(invoice.dueAmount).toBe(75000);
    expect(invoicePaymentStatus({ ...invoice, currentRetailerDue: 75000 })).toEqual({ kind: 'due', amount: 75000 });
    expect(invoicePaymentStatus({ total: 10000, currentRetailerDue: 0 })).toEqual({ kind: 'unknown', amount: 0 });
  });
  it('combines partial payments and unpaid sales, applying returns and exchanges once', () => {
    const invoices = [
      { total: 900000, paidAmount: 500000 },
      { total: 150000, paidAmount: 0 },
      { total: -100000, paidAmount: 0 },
      { total: 500000, paidAmount: 300000 }
    ];
    expect(recordedBalance(invoices)).toEqual({ balance: 650000, due: 650000, credit: 0, unrecorded: 0 });
  });
  it('shows credits and flags unrecorded invoices without inventing a payment status', () => {
    expect(recordedBalance([{ total: 100000, paidAmount: 100000 }, { total: -50000, paidAmount: 0 }, { total: 250000 }])).toEqual({ balance: -50000, due: 0, credit: 50000, unrecorded: 1 });
    expect(recordedBalance([])).toEqual({ balance: 0, due: 0, credit: 0, unrecorded: 0 });
  });
});

describe('retailer profile totals', () => {
  it('shows units sold/returned and combined paid amounts without summing old due snapshots', () => {
    const totals = retailerTotals([
      { total: 75000, paidAmount: 0, lines: [{ quantity: 1 }] },
      { total: 150000, paidAmount: 225000, lines: [{ quantity: 3 }], returnLines: [{ quantity: 1 }] }
    ]);
    expect(totals).toMatchObject({ orders: 2, sold: 4, returned: 1, paid: 225000, net: 225000, due: 0, unrecorded: 0 });
  });
});

describe('Invoice filter validation', () => {
  it('treats search punctuation literally and searches invoice and retailer snapshots', () => {
    expect(invoiceQuery(new URLSearchParams({ search: '  Shop (A).*  ' }))).toEqual({ $or: ['number', 'retailer.name', 'retailer.shopName'].map(field => ({ [field]: { $regex: 'Shop \\(A\\)\\.\\*', $options: 'i' } })) });
    expect(invoiceQuery(new URLSearchParams({ search: '   ' }))).toEqual({});
    expect(() => invoiceQuery(new URLSearchParams({ search: 'x'.repeat(101) }))).toThrow();
  });
  it('uses inclusive Dhaka calendar dates with an exclusive next-day boundary', () => {
    const retailerId = randomUUID();
    expect(invoiceQuery(new URLSearchParams({ retailerId, startDate: '2026-10-05', endDate: '2026-10-05' }))).toEqual({ retailerId, createdAt: { $gte: new Date('2026-10-04T18:00:00Z'), $lt: new Date('2026-10-05T18:00:00Z') } });
  });
  it('rejects impossible dates and reversed ranges', () => {
    for (const params of ['startDate=2026-02-30', 'startDate=2026-10-06&endDate=2026-10-05']) expect(() => invoiceQuery(new URLSearchParams(params))).toThrow();
    expect(invoiceQuery(new URLSearchParams())).toEqual({});
  });
});

describe('Dashboard date windows', () => {
  const now = new Date('2026-10-04T19:00:00Z'); // October 5 in Dhaka.
  it('uses Dhaka calendar days and includes today in preset ranges', () => {
    expect(dashboardQuery(new URLSearchParams({ period: 'all' }), now)).toEqual({});
    for (const [period, start] of [['today', '2026-10-04T18:00:00Z'], ['7days', '2026-09-28T18:00:00Z'], ['30days', '2026-09-05T18:00:00Z']]) {
      expect(dashboardQuery(new URLSearchParams({ period }), now)).toEqual({ createdAt: { $gte: new Date(start), $lt: new Date('2026-10-05T18:00:00Z') } });
    }
  });
  it('validates custom dates and includes both selected days', () => {
    expect(dashboardQuery(new URLSearchParams({ period: 'custom', startDate: '2026-10-01', endDate: '2026-10-05' }), now)).toEqual({ createdAt: { $gte: new Date('2026-09-30T18:00:00Z'), $lt: new Date('2026-10-05T18:00:00Z') } });
    for (const params of ['period=custom', 'period=custom&startDate=2026-10-05&endDate=2026-10-01', 'period=unsupported']) expect(() => dashboardQuery(new URLSearchParams(params), now)).toThrow();
  });
});
