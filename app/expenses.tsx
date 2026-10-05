import { useCallback, useEffect, useRef, useState } from 'react';
import type { Expense } from '@/lib/business';
import { operationSchema, parseTaka, taka, validationMessage } from '@/lib/validation';

type ExpenseRow = Omit<Expense, 'createdAt'> & { createdAt: string };
type ExpenseData = { expenses: ExpenseRow[]; total: number; count: number };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
export default function Expenses({ onSave }: { onSave: (operation: unknown) => Promise<boolean> }) {
  const [data, setData] = useState<ExpenseData>();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState({ period: 'all', startDate: today(), endDate: today() });
  const rangeKey = new URLSearchParams(range).toString();
  const currentRange = useRef(rangeKey);
  currentRange.current = rangeKey;
  const load = useCallback(async (offset = 0, signal?: AbortSignal) => {
    const response = await fetch(`/api/data?collection=expenses&offset=${offset}&${rangeKey}`, { cache: 'no-store', signal });
    const result: ExpenseData & { error?: string } = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load expenses.');
    if (!signal?.aborted && currentRange.current === rangeKey) setData(current => ({ ...result, expenses: offset ? [...(current?.expenses ?? []), ...result.expenses] : result.expenses }));
  }, [rangeKey]);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError('');
    if (range.period === 'custom' && (!range.startDate || !range.endDate || range.startDate > range.endDate)) {
      setError('Select a valid start and end date.');
      return () => controller.abort();
    }
    load(0, controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [load, range.period, range.startDate, range.endDate]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const operation = operationSchema.safeParse({ type: 'expense', description, expenseDate, amount: parseTaka(amount) });
      if (!operation.success) throw new Error(validationMessage(operation.error));
      if (await onSave(operation.data)) {
        setDescription(''); setAmount(''); setExpenseDate(today()); setOpen(false);
        await load();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="section-title"><p className="intro">Record business expenses and review your spending.</p><button disabled={busy} aria-expanded={open} aria-controls="expense-form" onClick={() => setOpen(true)}>Add expense +</button></div>
    <div className="dashboard-toolbar"><label>Date range<select disabled={busy} value={range.period} onChange={e => setRange({ ...range, period: e.target.value })}><option value="all">All</option><option value="today">Today</option><option value="7days">Last 7 days</option><option value="30days">Last 30 days</option><option value="custom">Custom range</option></select></label>{range.period === 'custom' && <><label>From<input type="date" disabled={busy} value={range.startDate} max={range.endDate || undefined} onChange={e => setRange({ ...range, startDate: e.target.value })}/></label><label>To<input type="date" disabled={busy} value={range.endDate} min={range.startDate || undefined} onChange={e => setRange({ ...range, endDate: e.target.value })}/></label></>}<small>Expense dates · Asia/Dhaka</small></div>
    {error && <p className="error" role="alert">{error}</p>}
    {open && <section id="expense-form"><h2>Add expense</h2><form className="expense-form" onSubmit={save}>
      <label>Description<input autoFocus required maxLength={160} placeholder="e.g. Shop rent, electricity, packaging" value={description} onChange={e => setDescription(e.target.value)}/></label>
      <label>Amount (৳)<input required inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)}/></label>
      <label>Expense date<input type="date" required value={expenseDate} onChange={e => setExpenseDate(e.target.value)}/></label>
      <div className="expense-actions"><button disabled={busy}>{busy ? 'Saving…' : 'Save expense'}</button><button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(false); setDescription(''); setAmount(''); setExpenseDate(today()); setError(''); }}>Cancel</button></div>
    </form></section>}
    <section><div className="section-title"><h2>Expense history</h2><strong>Total expenses: {data ? taka(data.total) : '…'}</strong></div>
      {data ? <><div className="table-scroll"><table className="transactions-table"><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>{data.expenses.map(expense => <tr key={expense._id}><td>{new Date(`${expense.expenseDate}T12:00:00+06:00`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium' })}</td><td>{expense.description}</td><td>{taka(expense.amount)}</td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={2}>Total · {data.count} expenses</th><td>{taka(data.total)}</td></tr></tfoot></table></div>{!data.count && <p className="empty">No expenses in this date range.</p>}{data.expenses.length < data.count && <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await load(data.expenses.length); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Load older expenses</button>}</> : <p role="status">{error ? 'Select a valid date range or retry.' : 'Loading expenses…'}</p>}
    </section>
  </>;
}
