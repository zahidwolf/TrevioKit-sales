import { useEffect, useState } from 'react';
import type { AnalysisStats } from '@/lib/analysis-stats';
import { taka } from '@/lib/validation';
import DashboardCharts from './dashboard-charts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
export default function Analysis() {
  const [range, setRange] = useState({ period: 'all', startDate: today(), endDate: today() });
  const [data, setData] = useState<AnalysisStats>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError('');
    (async () => {
      try {
        if (range.period === 'custom' && (!range.startDate || !range.endDate || range.startDate > range.endDate)) throw new Error('Select a valid start and end date.');
        const response = await fetch(`/api/data?${new URLSearchParams({ collection: 'analysis', ...range })}`, { cache: 'no-store', signal: controller.signal });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load analysis.');
        if (!controller.signal.aborted) setData(result);
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    })();
    return () => controller.abort();
  }, [range, retry]);
  const maxExpense = Math.max(1, ...(data?.expenseChart.map(point => point.amount) ?? []));
  return <>
    <div className="dashboard-toolbar"><p className="intro">Understand your sales, payments and spending.</p><label>Date range<select value={range.period} onChange={e => setRange({ ...range, period: e.target.value })}><option value="all">All</option><option value="today">Today</option><option value="7days">Last 7 days</option><option value="30days">Last 30 days</option><option value="custom">Custom range</option></select></label>{range.period === 'custom' && <><label>From<input type="date" value={range.startDate} max={range.endDate || undefined} onChange={e => setRange({ ...range, startDate: e.target.value })}/></label><label>To<input type="date" value={range.endDate} min={range.startDate || undefined} onChange={e => setRange({ ...range, endDate: e.target.value })}/></label></>}</div>
    {error ? <p className="error" role="alert">{error} <button className="secondary" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : !data ? <p role="status">Loading analysis…</p> : <>
      <div className="stats analysis-stats">
        {[
          ['NET REVENUE', taka(data.net), 'Sales less original-price return credits'],
          ['TOTAL PAID', taka(data.paid), 'Payments received, including previous due'],
          ['TOTAL EXPENSES', taka(data.expenses), `${data.expenseCount} recorded expenses`],
          ['REVENUE AFTER EXPENSES', taka(data.afterExpenses), 'Net revenue minus recorded expenses'],
          ['UNITS SOLD', data.unitsSold.toLocaleString(), `${data.unitsReturned.toLocaleString()} units returned`],
          ['CURRENT DUE', taka(data.due), `All dates · retailer credit ${taka(data.credit)}`],
        ].map(([label, value, description]) => <article key={label}><small>{label}</small><h2>{value}</h2><p>{description}</p></article>)}
      </div>
      <p className="muted">Sales and payments follow transaction dates; spending follows expense dates in Asia/Dhaka. Current due includes all dates. Revenue after expenses excludes product costs and is not a profit calculation.</p>
      {data.unrecorded > 0 && <p className="notice">{data.unrecorded} older invoice(s) have no payment record and are excluded from paid and due totals.</p>}
      <DashboardCharts points={data.chart} monthly={data.chartMonthly}/>
      <section><h2>Expense trends</h2><p className="muted">{data.chartMonthly ? 'Latest 24 active months' : 'Latest 60 active days'} in the selected range</p>{!data.expenseChart.length ? <p className="empty">No expenses in this date range.</p> : <div className="expense-trends">{data.expenseChart.map(point => <div className="expense-trend" key={point._id}><span>{point._id}</span><div className="expense-bar-track"><div className="expense-bar" style={{ width: `${point.amount / maxExpense * 100}%` }}/></div><strong>{taka(point.amount)}</strong></div>)}</div>}</section>
      <section><h2>Top products & sizes</h2><p className="muted">Top 10 by net revenue · product names from transaction records</p><div className="table-scroll"><table className="transactions-table"><thead><tr><th>Product</th><th>Size</th><th>Units sold</th><th>Returned</th><th>Net revenue</th></tr></thead><tbody>{data.products.map(product => <tr key={product._id}><td>{product.name}</td><td>{product.size}</td><td>{product.sold}</td><td>{product.returned}</td><td>{taka(product.net)}</td></tr>)}</tbody></table></div>{!data.products.length && <p className="empty">No products sold or returned in this date range.</p>}</section>
      <section><h2>Top retailers</h2><p className="muted">Top 10 by net revenue in the selected range</p><div className="table-scroll"><table className="transactions-table"><thead><tr><th>Shop / retailer</th><th>Transactions</th><th>Units sold</th><th>Returned</th><th>Net revenue</th><th>Paid</th></tr></thead><tbody>{data.retailers.map(retailer => <tr key={retailer._id}><td>{retailer.name}</td><td>{retailer.transactions}</td><td>{retailer.sold}</td><td>{retailer.returned}</td><td>{taka(retailer.net)}</td><td>{taka(retailer.paid)}</td></tr>)}</tbody></table></div>{!data.retailers.length && <p className="empty">No retailer transactions in this date range.</p>}</section>
    </>}
  </>;
}
