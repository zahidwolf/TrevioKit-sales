import type { Db, Filter } from 'mongodb';
import type { Invoice, Expense } from './business';
import { dashboardStats, type DashboardStats } from './dashboard-stats';
export type ProductAnalysis = { _id: string; name: string; size: string; sold: number; returned: number; net: number };
export type RetailerAnalysis = { _id: string; name: string; transactions: number; sold: number; returned: number; net: number; paid: number };
export type ExpensePoint = { _id: string; amount: number };
export type AnalysisStats = DashboardStats & { expenses: number; expenseCount: number; afterExpenses: number; products: ProductAnalysis[]; retailers: RetailerAnalysis[]; expenseChart: ExpensePoint[] };

export async function analysisStats(db: Db, query: Filter<Invoice>, expenseFilter: Filter<Expense>, monthly: boolean): Promise<AnalysisStats> {
  const [sales, spending, products, retailers, expenseChart] = await Promise.all([
    dashboardStats(db, query, monthly),
    db.collection<Expense>('expenses').aggregate<{ amount: number; count: number }>([
      { $match: expenseFilter }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]).toArray(),
    db.collection<Invoice>('invoices').aggregate<ProductAnalysis>([
      { $match: query }, { $sort: { createdAt: -1, _id: -1 } },
      { $project: { items: { $concatArrays: [
        { $map: { input: '$lines', as: 'line', in: { productId: '$$line.productId', name: '$$line.name', size: '$$line.size', sold: '$$line.quantity', returned: 0, net: { $multiply: ['$$line.quantity', '$$line.unitPrice'] } } } },
        { $map: { input: { $ifNull: ['$returnLines', []] }, as: 'line', in: { productId: '$$line.productId', name: '$$line.name', size: '$$line.size', sold: 0, returned: '$$line.quantity', net: { $multiply: ['$$line.quantity', '$$line.unitPrice', -1] } } } },
      ] } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', name: { $first: '$items.name' }, size: { $first: '$items.size' }, sold: { $sum: '$items.sold' }, returned: { $sum: '$items.returned' }, net: { $sum: '$items.net' } } },
      { $sort: { net: -1, sold: -1, _id: 1 } }, { $limit: 10 },
    ]).toArray(),
    db.collection<Invoice>('invoices').aggregate<RetailerAnalysis>([
      { $match: query }, { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: '$retailerId', name: { $first: { $cond: [{ $ne: ['$retailer.shopName', ''] }, '$retailer.shopName', '$retailer.name'] } }, transactions: { $sum: 1 }, sold: { $sum: { $sum: '$lines.quantity' } }, returned: { $sum: { $sum: { $ifNull: ['$returnLines.quantity', []] } } }, net: { $sum: '$total' }, paid: { $sum: { $ifNull: ['$paidAmount', 0] } } } },
      { $sort: { net: -1, _id: 1 } }, { $limit: 10 },
    ]).toArray(),
    db.collection<Expense>('expenses').aggregate<ExpensePoint>([
      { $match: expenseFilter },
      { $group: { _id: monthly ? { $substrBytes: ['$expenseDate', 0, 7] } : '$expenseDate', amount: { $sum: '$amount' } } },
      { $sort: { _id: -1 } }, { $limit: monthly ? 24 : 60 },
    ]).toArray(),
  ]);
  const expenses = spending[0]?.amount ?? 0;
  return { ...sales, expenses, expenseCount: spending[0]?.count ?? 0, afterExpenses: sales.net - expenses, products, retailers, expenseChart: expenseChart.reverse() };
}
