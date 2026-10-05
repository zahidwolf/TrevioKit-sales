import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { database } from '@/lib/db';
import { failure } from '@/lib/http';
import { invoiceQuery } from '@/lib/invoice-filters';
import { dashboardQuery } from '@/lib/dashboard-filters';
import { dashboardStats } from '@/lib/dashboard-stats';
import { expenseQuery } from '@/lib/expense-filters';
import { withInvoiceStatus } from '@/lib/invoice-status';
import { analysisStats } from '@/lib/analysis-stats';
import type { Invoice, History, Expense } from '@/lib/business';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await requireOwner(); const { db } = await database();
    const url = new URL(request.url);
    const collection = url.searchParams.get('collection');
    if (collection === 'analysis') {
      if (!url.searchParams.has('period')) url.searchParams.set('period', 'all');
      const query = dashboardQuery(url.searchParams);
      const expenseFilter = expenseQuery(url.searchParams);
      const monthly = url.searchParams.get('period') === 'all' || (url.searchParams.get('period') === 'custom' && new Date(url.searchParams.get('endDate')!).getTime() - new Date(url.searchParams.get('startDate')!).getTime() > 90 * 86400000);
      return NextResponse.json(await analysisStats(db, query, expenseFilter, monthly), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (collection === 'expenses') {
      const query = expenseQuery(url.searchParams);
      const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get('offset')) || 0));
      const [expenses, totals] = await Promise.all([
        db.collection<Expense>('expenses').find(query).sort({ expenseDate: -1, createdAt: -1, _id: -1 }).skip(offset).limit(100).toArray(),
        db.collection<Expense>('expenses').aggregate<{ total: number; count: number }>([{ $match: query }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray(),
      ]);
      return NextResponse.json({ expenses, total: totals[0]?.total ?? 0, count: totals[0]?.count ?? 0 }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (collection === 'dashboard') {
      const query = dashboardQuery(url.searchParams);
      const [invoices, history, totals] = await Promise.all([
        db.collection<Invoice>('invoices').find(query).sort({ createdAt: -1, _id: -1 }).limit(8).toArray(),
        db.collection<History>('history').find(query).sort({ createdAt: -1, _id: -1 }).limit(10).toArray(),
        dashboardStats(db, query, url.searchParams.get('period') === 'all' || (url.searchParams.get('period') === 'custom' && new Date(url.searchParams.get('endDate')!).getTime() - new Date(url.searchParams.get('startDate')!).getTime() > 90 * 86400000)),
      ]);
      return NextResponse.json({ invoices: await withInvoiceStatus(db, invoices), history, ...totals }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (collection === 'invoices' || collection === 'history') {
      const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get('offset')) || 0));
      const records = collection === 'invoices'
        ? await db.collection<Invoice>('invoices').find(invoiceQuery(url.searchParams)).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(100).toArray()
        : await db.collection<History>('history').find().sort({ createdAt: -1, _id: -1 }).skip(offset).limit(100).toArray();
      return NextResponse.json(collection === 'invoices' ? await withInvoiceStatus(db, records as Invoice[]) : records, { headers: { 'Cache-Control': 'no-store' } });
    }
    const [products, retailers, invoices] = await Promise.all([
      db.collection('products').find().sort({ name: 1 }).toArray(),
      db.collection('retailers').find().sort({ name: 1 }).toArray(),
      db.collection<Invoice>('invoices').find().sort({ createdAt: -1, _id: -1 }).limit(100).toArray(),
    ]);
    return NextResponse.json({ products, retailers, invoices: await withInvoiceStatus(db, invoices) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
