import type { Db } from 'mongodb';
import type { Invoice } from './business';

// Read current balances from complete history, independently of list filters or pagination.
// Issued invoice amounts remain immutable; this is display metadata only.
export async function withInvoiceStatus<T extends { retailerId: string }>(db: Db, invoices: T[]) {
  if (!invoices.length) return [] as (T & { currentRetailerDue: number })[];
  const ids = [...new Set(invoices.map(invoice => invoice.retailerId))];
  const balances = await db.collection<Invoice>('invoices').aggregate<{ _id: string; balance: number }>([
    { $match: { retailerId: { $in: ids }, paidAmount: { $exists: true, $ne: null } } },
    { $group: { _id: '$retailerId', balance: { $sum: { $subtract: ['$total', '$paidAmount'] } } } },
  ]).toArray();
  const dues = new Map(balances.map(balance => [balance._id, Math.max(0, balance.balance)]));
  return invoices.map(invoice => ({ ...invoice, currentRetailerDue: dues.get(invoice.retailerId) ?? 0 }));
}
