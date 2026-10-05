import type { Db, Filter } from 'mongodb';
import type { Invoice } from './business';

export type ChartPoint = { _id: string; revenue: number; paid: number; sold: number; returned: number };
export type DashboardStats = { net: number; paid: number; unitsSold: number; unitsReturned: number; due: number; credit: number; unrecorded: number; chart: ChartPoint[]; chartMonthly: boolean };

export async function dashboardStats(db: Db, query: Filter<Invoice>, chartMonthly: boolean): Promise<DashboardStats> {
  const recorded = { $ne: [{ $ifNull: ['$paidAmount', null] }, null] };
  const sold = { $sum: '$lines.quantity' };
  const returned = { $sum: { $ifNull: ['$returnLines.quantity', []] } };
  const [totals, accounts, chart] = await Promise.all([
    db.collection<Invoice>('invoices').aggregate<{ net: number; paid: number; unitsSold: number; unitsReturned: number }>([
      { $match: query },
      { $group: { _id: null, net: { $sum: '$total' }, paid: { $sum: { $ifNull: ['$paidAmount', 0] } }, unitsSold: { $sum: sold }, unitsReturned: { $sum: returned } } },
    ]).toArray(),
    // Current due uses the complete retailer ledger, not historical due snapshots.
    // A later payment can settle an older invoice without changing the old invoice.
    db.collection<Invoice>('invoices').aggregate<{ due: number; credit: number; unrecorded: number }>([
      { $group: { _id: '$retailerId', balance: { $sum: { $cond: [recorded, { $subtract: ['$total', '$paidAmount'] }, 0] } }, unrecorded: { $sum: { $cond: [recorded, 0, 1] } } } },
      { $group: { _id: null, due: { $sum: { $max: [0, '$balance'] } }, credit: { $sum: { $max: [0, { $multiply: ['$balance', -1] }] } }, unrecorded: { $sum: '$unrecorded' } } },
    ]).toArray(),
    db.collection<Invoice>('invoices').aggregate<ChartPoint>([
      { $match: query },
      { $group: { _id: { $dateToString: { date: '$createdAt', format: chartMonthly ? '%Y-%m' : '%Y-%m-%d', timezone: 'Asia/Dhaka' } }, revenue: { $sum: '$total' }, paid: { $sum: { $ifNull: ['$paidAmount', 0] } }, sold: { $sum: sold }, returned: { $sum: returned } } },
      { $sort: { _id: -1 } }, { $limit: chartMonthly ? 24 : 60 },
    ]).toArray(),
  ]);
  return { net: totals[0]?.net ?? 0, paid: totals[0]?.paid ?? 0, unitsSold: totals[0]?.unitsSold ?? 0, unitsReturned: totals[0]?.unitsReturned ?? 0, due: accounts[0]?.due ?? 0, credit: accounts[0]?.credit ?? 0, unrecorded: accounts[0]?.unrecorded ?? 0, chart: chart.reverse(), chartMonthly };
}
