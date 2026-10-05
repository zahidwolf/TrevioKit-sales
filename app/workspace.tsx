'use client';
import { useEffect, useRef, useState } from 'react';
import InvoiceDocument from './invoice';
import DashboardCharts from './dashboard-charts';
import Expenses from './expenses';
import Analysis from './analysis';
import type { DashboardStats } from '@/lib/dashboard-stats';
import type { Product, Retailer, Invoice, History } from '@/lib/business';
import { recordedBalance, retailerTotals, invoicePaymentStatus } from '@/lib/balance';
import { operationSchema, validationMessage, parseTaka, taka } from '@/lib/validation';
type Bill = Omit<Invoice, 'createdAt'> & { createdAt: string; currentRetailerDue?: number };
type Data = { products: Product[]; retailers: Retailer[]; invoices: Bill[] };
type DraftLine = { productId: string; quantity: number; price: string };
const blankProduct = { name: '', size: '', unitPrice: '0', initialQuantity: '0', imageUrl: '', active: true };
const blankRetailer = { name: '', phone: '', shopName: '', address: '', active: true };
const date = (v: string | Date) => new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' });
function paymentStatusLabel(invoice: Bill) {
  const status = invoicePaymentStatus(invoice);
  return status.kind === 'unknown' ? 'Not recorded' : status.kind === 'paid' ? 'Fully paid' : status.kind === 'credit' ? `Credit ${taka(status.amount)}` : `Due ${taka(status.amount)}`;
}
const tabs = ['Dashboard', 'Inventory', 'New Sale / Exchange', 'Retailers', 'Sales / Invoices', 'Expenses', 'Analysis'];
export default function Workspace() {
  const [data, setData] = useState<Data>(); const [tab, setTab] = useState(tabs[0]); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [showProductForm, setShowProductForm] = useState(false);
  const [showRetailerForm, setShowRetailerForm] = useState(false);
  const [search, setSearch] = useState(''); const [showArchived, setShowArchived] = useState(false);
  const [product, setProduct] = useState<{ id?: string } & typeof blankProduct>(blankProduct); const [retailer, setRetailer] = useState<{ id?: string } & typeof blankRetailer>(blankRetailer);
  const [retailerId, setRetailerId] = useState(''); const [original, setOriginal] = useState(''); const [retailerBills, setRetailerBills] = useState<Bill[]>([]); const [profile, setProfile] = useState('');
  const [paidAmount, setPaidAmount] = useState('0');
  const [lines, setLines] = useState<DraftLine[]>([]); const [returns, setReturns] = useState<Record<string, number>>({}); const [reason, setReason] = useState(''); const [note, setNote] = useState('');
  const [bill, setBill] = useState<Bill>(); const [bills, setBills] = useState<Bill[]>([]); const [hasMore, setHasMore] = useState(true);
  const [dashboardRange, setDashboardRange] = useState({ period: 'today', startDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }), endDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) });
  const [dashboard, setDashboard] = useState<DashboardStats & { invoices: Bill[]; history: History[] }>();
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState('');
  const [invoiceFilters, setInvoiceFilters] = useState({ retailerId: '', startDate: '', endDate: '', search: '' });
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const invoiceRequest = useRef(0);
  const returnReasonInput = useRef<HTMLInputElement>(null);
  const historyRequest = useRef(0);
  const [historyRetailerId, setHistoryRetailerId] = useState('');
  const pending = useRef<{ payload: string; key: string } | null>(null);
  async function load() { const response = await fetch('/api/data', { cache: 'no-store' }); if (response.status === 401) { location.href = '/login'; return; } const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(result); return result as Data; }
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  useEffect(() => { if (tab === 'New Sale / Exchange' && retailerId) historyFor(retailerId).catch(e => setError(e.message)); }, [tab, retailerId]);
  async function historyFor(id: string) {
    const request = ++historyRequest.current;
    setHistoryRetailerId('');
    const all: Bill[] = [];
    for (let offset = 0; ; offset += 100) { const res = await fetch(`/api/data?collection=invoices&retailerId=${encodeURIComponent(id)}&offset=${offset}`); const page = await res.json(); if (!res.ok) throw new Error(page.error); all.push(...page); if (page.length < 100) break; }
    if (request === historyRequest.current) { setRetailerBills(all); setHistoryRetailerId(id); }
  }
  async function submit(op: unknown): Promise<boolean> {
    setBusy(true); setError(''); setNotice(''); const payload = JSON.stringify(op);
    if (pending.current?.payload !== payload) pending.current = { payload, key: crypto.randomUUID() };
    try { const response = await fetch('/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current!.key }, body: payload }); const result = await response.json(); if (!response.ok) { if (response.status < 500) pending.current = null; if (result.error?.startsWith('Retailer balance changed') && retailerId) await historyFor(retailerId); throw new Error(result.error); } const refreshed = await load(); setNotice('Saved successfully.'); if (result.invoiceId) { setBill(refreshed?.invoices.find(i => i._id === result.invoiceId)); setTab('Sales / Invoices'); } if (retailerId) await historyFor(retailerId); pending.current = null; return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  useEffect(() => {
    if (tab !== 'Dashboard' || !data) return;
    const controller = new AbortController();
    setDashboard(undefined); setDashboardLoading(true); setDashboardError('');
    (async () => {
      try {
        if (dashboardRange.period === 'custom' && (!dashboardRange.startDate || !dashboardRange.endDate || dashboardRange.startDate > dashboardRange.endDate)) throw new Error('Select a valid start and end date.');
        const params = new URLSearchParams({ collection: 'dashboard', ...dashboardRange });
        const response = await fetch(`/api/data?${params}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (!controller.signal.aborted) setDashboard(result);
      } catch (e) { if (!controller.signal.aborted) setDashboardError((e as Error).message); }
      finally { if (!controller.signal.aborted) setDashboardLoading(false); }
    })();
    return () => controller.abort();
  }, [tab, dashboardRange, data]);
  function invoiceUrl(offset = 0) {
    const params = new URLSearchParams({ collection: 'invoices', offset: String(offset) });
    for (const [key, value] of Object.entries(invoiceFilters)) if (value) params.set(key, value);
    return `/api/data?${params}`;
  }
  useEffect(() => {
    const request = ++invoiceRequest.current;
    if (tab !== 'Sales / Invoices') return;
    const controller = new AbortController();
    setBills([]); setHasMore(false); setInvoicesLoading(true); setError('');
    if (invoiceFilters.startDate && invoiceFilters.endDate && invoiceFilters.startDate > invoiceFilters.endDate) {
      setError('Start date must be before end date.'); setInvoicesLoading(false); return;
    }
    (async () => {
      try {
        const response = await fetch(invoiceUrl(), { cache: 'no-store', signal: controller.signal });
        const page = await response.json();
        if (!response.ok) throw new Error(page.error);
        if (request === invoiceRequest.current) { setBills(page); setHasMore(page.length === 100); }
      } catch (e) {
        if (!controller.signal.aborted && request === invoiceRequest.current) setError((e as Error).message);
      } finally { if (request === invoiceRequest.current) setInvoicesLoading(false); }
    })();
    return () => controller.abort();
  }, [tab, invoiceFilters]);
  async function loadOlderInvoices() {
    const request = invoiceRequest.current;
    setInvoicesLoading(true);
    try {
      const response = await fetch(invoiceUrl(bills.length), { cache: 'no-store' });
      const page = await response.json();
      if (!response.ok) throw new Error(page.error);
      if (request === invoiceRequest.current) { setBills(current => [...current, ...page]); setHasMore(page.length === 100); }
    } catch (e) { if (request === invoiceRequest.current) setError((e as Error).message); }
    finally { if (request === invoiceRequest.current) setInvoicesLoading(false); }
  }
  const retailerHistoryReady = !!retailerId && historyRetailerId === retailerId;
  const previous = recordedBalance(retailerHistoryReady ? retailerBills.filter(b => b.retailerId === retailerId) : []);
  const originalBill = retailerBills.find(b => b._id === original);
  const credit = (originalBill?.lines ?? []).reduce((sum, l) => sum + (returns[l.productId] ?? 0) * l.unitPrice, 0);
  const saleTotal = lines.reduce((sum, l) => { try { return sum + l.quantity * parseTaka(l.price); } catch { return sum; } }, 0);
  const netAmount = saleTotal - credit;
  const totalPayable = Math.max(0, previous.balance + netAmount);
  let paidPoisha: number | undefined;
  try { paidPoisha = totalPayable > 0 ? parseTaka(paidAmount) : 0; } catch {}
  const balanceAfter = paidPoisha === undefined ? undefined : previous.balance + netAmount - paidPoisha;
  function changeLine(index: number, changes: Partial<DraftLine>) { setLines(lines.map((line, i) => i === index ? { ...line, ...changes } : line)); }
  async function saveSale() {
    setError('');
    try {
      const saleLines = lines.map(l => ({ productId: l.productId, quantity: l.quantity, unitPrice: parseTaka(l.price) }));
      const returnLines = Object.entries(returns).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity }));
      if (!retailerId) throw new Error('Select a retailer');
      if (!retailerHistoryReady) throw new Error('Wait for this retailer’s previous transactions to load.');
      if (!saleLines.length && !returnLines.length) throw new Error('Add sale products or return quantities');
      const payment = totalPayable > 0 ? parseTaka(paidAmount) : 0;
      if (payment > totalPayable) throw new Error('Paid amount cannot exceed total payable, including previous due');
      const op = returnLines.length ? { type: 'return', paidAmount: payment, expectedBalance: previous.balance, retailerId, invoiceId: original, lines: returnLines, reason, ...(saleLines.length ? { exchangeLines: saleLines } : {}) } : { type: 'sale', paidAmount: payment, expectedBalance: previous.balance, retailerId, lines: saleLines, note };
      const validated = operationSchema.safeParse(op);
      if (!validated.success) {
        if (validated.error.issues.some(issue => issue.path[0] === 'reason')) returnReasonInput.current?.focus();
        throw new Error(validationMessage(validated.error));
      }
      if (await submit(validated.data)) { setPaidAmount('0'); setLines([]); setReturns({}); setOriginal(''); setReason(''); setNote(''); }
    } catch (e) { setError((e as Error).message); }
  }
  if (!data) return <main className="loading"><h1>TrevioKit</h1><p>{error || 'Opening your workspace…'}</p><a href="/login">Owner login</a></main>;
  const productList = data.products.filter(p => (showArchived || p.active) && `${p.name} ${p.size}`.toLowerCase().includes(search.toLowerCase()));
  const profileRetailer = data.retailers.find(r => r._id === profile);
  const profileInvoices = retailerBills.filter(i => i.retailerId === profile);
  const profileTotals = retailerTotals(profileInvoices);
  function openRetailer(id: string) {
    setProfile(id); setShowRetailerForm(false); setError(''); setNotice('');
    setRetailerBills([]); setHistoryRetailerId('');
    historyFor(id).catch(e => setError(e.message));
  }
  function invoiceTable(items: Bill[]) { return <div className="table-scroll"><table className="transactions-table"><thead><tr><th>Invoice / date</th><th>Retailer</th><th>Type</th><th>Units</th><th>Net value</th><th>Paid</th><th>Payment status</th><th/></tr></thead><tbody>{items.map(i => <tr key={i._id}><td><strong>{i.number.length > 15 ? `${i.number.slice(0, 15)}…` : i.number}</strong><small>{date(i.createdAt)}</small></td><td>{i.retailer.name}</td><td>{i.returnLines ? (i.lines.length ? 'Exchange' : 'Return') : 'Sale'}</td><td>{i.lines.length > 0 && <span>{i.lines.reduce((sum, line) => sum + line.quantity, 0).toLocaleString()} taken</span>}{i.returnLines && <small>{i.returnLines.reduce((sum, line) => sum + line.quantity, 0).toLocaleString()} returned</small>}</td><td>{i.total < 0 ? `Credit ${taka(-i.total)}` : taka(i.total)}</td><td>{i.paidAmount === undefined ? 'Not recorded' : taka(i.paidAmount)}</td><td>{paymentStatusLabel(i)}</td><td><button className="secondary" onClick={() => setBill(i)}>View invoice</button></td></tr>)}</tbody></table>{!items.length && <p className="empty">No transactions yet.</p>}</div>; }
  return <div className="shell"><aside className="no-print"><div className="brand">TrevioKit<span>INVENTORY & RETAILERS</span></div><nav>{tabs.map(t => <button key={t} className={t === tab ? 'selected' : ''} onClick={() => { setTab(t); setSearch(''); setBill(undefined); setProfile(''); setShowProductForm(false); setShowRetailerForm(false); }}>{t}</button>)}</nav><div className="aside-bottom"><small>Owner workspace<br/>Asia/Dhaka · BDT</small><button className="secondary" onClick={async () => { const res = await fetch('/api/auth/logout', { method: 'POST' }); if (res.ok) location.href = '/login'; else setError('Sign out failed. Please retry.'); }}>Sign out</button></div></aside><main><header className="no-print"><div><small>TREVIOKIT / WORKSPACE</small><h1>{tab}</h1></div><span className="badge">OWNER</span></header>{error && <p role="alert" className="error no-print">{error}</p>}{notice && <p role="status" className="notice no-print">{notice}</p>}
  {tab === 'Dashboard' && <><div className="dashboard-toolbar"><p className="intro">Your stock and business activity, at a glance.</p><label>Date range<select value={dashboardRange.period} onChange={e => setDashboardRange({ ...dashboardRange, period: e.target.value })}><option value="all">All</option><option value="today">Today</option><option value="7days">Last 7 days</option><option value="30days">Last 30 days</option><option value="custom">Custom range</option></select></label>{dashboardRange.period === 'custom' && <><label>From<input type="date" value={dashboardRange.startDate} max={dashboardRange.endDate || undefined} onChange={e => setDashboardRange({ ...dashboardRange, startDate: e.target.value })}/></label><label>To<input type="date" value={dashboardRange.endDate} min={dashboardRange.startDate || undefined} onChange={e => setDashboardRange({ ...dashboardRange, endDate: e.target.value })}/></label></>}</div>{dashboardError && <p className="error" role="alert">{dashboardError}</p>}<div className="stats dashboard-stats">
    <article><small>TOTAL REVENUE</small><h2>{dashboardLoading ? '…' : dashboard ? taka(dashboard.net) : '—'}</h2><p>Selected period · sales less returns</p></article>
    <article><small>TOTAL PAID</small><h2>{dashboardLoading ? '…' : dashboard ? taka(dashboard.paid) : '—'}</h2><p>Selected period · includes previous due payments</p></article>
    <article><small>TOTAL DUE</small><h2>{dashboardLoading ? '…' : dashboard ? taka(dashboard.due) : '—'}</h2><p>Current outstanding across all retailers</p>{!!dashboard?.credit && <p>Retailer credit: {taka(dashboard.credit)}</p>}</article>
    <article><small>UNITS SOLD</small><h2>{dashboardLoading ? '…' : dashboard ? dashboard.unitsSold.toLocaleString() : '—'}</h2><p>Selected period · {dashboard?.unitsReturned.toLocaleString() ?? '—'} returned</p></article>
    <article><small>UNITS IN STOCK</small><h2>{data.products.reduce((sum, p) => sum + p.stock, 0).toLocaleString()}</h2><p>Current stock · {data.products.length} product sizes</p></article>
  </div>{!!dashboard?.unrecorded && <p className="notice">{dashboard.unrecorded} older invoice(s) have no payment record. Paid and due totals include recorded amounts only.</p>}
  {dashboardLoading ? <section><p role="status">Loading charts…</p></section> : dashboard && <DashboardCharts points={dashboard.chart} monthly={dashboard.chartMonthly}/>}
  <section><div className="section-title"><h2>Recent transactions</h2><button onClick={() => setTab('New Sale / Exchange')}>New transaction +</button></div>{dashboardLoading ? <p role="status">Loading transactions…</p> : invoiceTable(dashboard?.invoices ?? [])}</section><section><h2>Recent activity</h2>{(dashboard?.history ?? []).map(h => <div className="activity" key={h._id}><span>{h.type === 'stock' ? 'Stock adjustment' : h.type === 'product' ? 'Product saved' : h.type === 'retailer' ? 'Retailer saved' : h.type === 'return' ? 'Return / exchange completed' : h.type === 'expense' ? 'Expense recorded' : 'Sale completed'}</span><small>{date(h.createdAt)}</small></div>)}{dashboardLoading ? <p role="status">Loading activity…</p> : !dashboard?.history.length && <p className="empty">No activity in this date range.</p>}</section></>}
  {tab === 'Inventory' && <><div className="toolbar"><input aria-label="Search products" placeholder="Search by product name or size…" value={search} onChange={e => setSearch(e.target.value)}/><label className="check"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/>Include archived</label><button disabled={busy} aria-expanded={showProductForm} aria-controls="product-form" onClick={() => { setProduct(blankProduct); setShowProductForm(true); }}>Add product +</button></div><div className={showProductForm ? "split" : ""}><section><h2>Products & sizes</h2><div className="table-scroll"><table className="inventory-table"><thead><tr><th>Product</th><th>Size</th><th>Price</th><th>Stock</th><th/></tr></thead><tbody>{productList.map(p => <tr key={p._id}><td>{p.imageUrl && <img className="thumbnail" src={p.imageUrl} alt="" referrerPolicy="no-referrer"/>}<strong>{p.name}</strong>{!p.active && <small>Archived</small>}</td><td>{p.size}</td><td>{taka(p.unitPrice)}</td><td>{p.stock}</td><td><button className="secondary" onClick={() => { setProduct({ id: p._id, name: p.name, size: p.size, unitPrice: (p.unitPrice / 100).toFixed(2), initialQuantity: '0', imageUrl: p.imageUrl, active: p.active }); setShowProductForm(true); }}>Edit</button></td></tr>)}</tbody><tfoot><tr><th colSpan={3} scope="row">Total stock · {productList.length} product sizes</th><td><strong>{productList.reduce((sum, p) => sum + p.stock, 0).toLocaleString()}</strong></td><td/></tr></tfoot></table></div>{!productList.length && <p className="empty">No matching products.</p>}</section>{showProductForm && <section><div id="product-form"><h2>{product.id ? 'Edit product' : 'Add product'}</h2><form onSubmit={async e => { e.preventDefault(); try { const { initialQuantity, ...fields } = product; if (await submit({ ...fields, type: 'product', unitPrice: parseTaka(product.unitPrice), ...(!product.id ? { initialStock: Number(initialQuantity) } : {}) })) { setProduct(blankProduct); setShowProductForm(false); } } catch (err) { setError((err as Error).message); } }}><label>Product name<input autoFocus required maxLength={160} value={product.name} onChange={e => setProduct({ ...product, name: e.target.value })}/></label><label>Size<input required maxLength={160} value={product.size} onChange={e => setProduct({ ...product, size: e.target.value })}/></label><label>Selling price (৳)<input required inputMode="decimal" value={product.unitPrice} onChange={e => setProduct({ ...product, unitPrice: e.target.value })}/></label>{!product.id && <label>Initial stock quantity<input type="number" min="0" max="1000000" step="1" required value={product.initialQuantity} onChange={e => setProduct({ ...product, initialQuantity: e.target.value })}/></label>}{product.id && <p className="muted">Change quantities using Adjust stock below.</p>}<label>Image URL (optional)<input type="url" placeholder="https://…" value={product.imageUrl} onChange={e => setProduct({ ...product, imageUrl: e.target.value })}/></label><label className="check"><input type="checkbox" checked={product.active} onChange={e => setProduct({ ...product, active: e.target.checked })}/>Active product</label><button disabled={busy}>Save product</button><button type="button" disabled={busy} className="secondary" onClick={() => { setProduct(blankProduct); setShowProductForm(false); }}>Cancel</button></form></div>{product.id && <><hr/><h2>Adjust stock</h2><form key={product.id} onSubmit={async e => { e.preventDefault(); const form = e.currentTarget; const fields = new FormData(form); if (await submit({ type: 'stock', productId: product.id, delta: Number(fields.get('delta')), reason: fields.get('reason') })) form.reset(); }}><label>Product<input readOnly value={`${data.products.find(p => p._id === product.id)?.name ?? product.name} / ${data.products.find(p => p._id === product.id)?.size ?? product.size} · ${data.products.find(p => p._id === product.id)?.stock ?? 0} units`}/></label><label>Quantity change<input name="delta" type="number" step="1" required placeholder="50 to add, -5 to remove"/></label><label>Reason<input name="reason" required maxLength={160}/></label><button disabled={busy}>Record adjustment</button></form></>}</section>}</div></>}
  {tab === 'Retailers' && <div className={showRetailerForm ? "split" : ""}><section>{!profile ? <><div className="section-title"><h2>Retailer directory</h2><button disabled={busy} aria-expanded={showRetailerForm} aria-controls="retailer-form" onClick={() => { setRetailer(blankRetailer); setShowRetailerForm(true); }}>Add retailer +</button></div><input aria-label="Search retailers" placeholder="Search retailer or shop…" value={search} onChange={e => setSearch(e.target.value)}/>{data.retailers.filter(r => `${r.name} ${r.shopName} ${r.phone}`.toLowerCase().includes(search.toLowerCase())).map(r => <div className="directory" key={r._id}><button className="retailer-link" onClick={() => openRetailer(r._id)} aria-label={`View all invoices for ${r.name}`}><strong>{r.name} {!r.active && '(archived)'}</strong><small>{r.shopName} · {r.phone}</small><small>{r.address}</small></button><div><button className="secondary" onClick={() => openRetailer(r._id)}>View invoices</button><button className="secondary" onClick={() => { setRetailer({ id: r._id, name: r.name, phone: r.phone, shopName: r.shopName, address: r.address, active: r.active }); setShowRetailerForm(true); }}>Edit</button></div></div>)}</> : <><div className="section-title"><div><h2>{profileRetailer?.name} · All invoices</h2><small>{profileRetailer?.shopName} · {profileRetailer?.phone}</small></div><button className="secondary" onClick={() => { historyRequest.current++; setProfile(''); setRetailerBills([]); setHistoryRetailerId(''); setError(''); }}>Back to retailers</button></div>{historyRetailerId !== profile ? <><p className="empty">{error ? 'Could not load the retailer’s invoices.' : 'Loading complete invoice history…'}</p>{error && <button className="secondary" onClick={() => openRetailer(profile)}>Retry</button>}</> : <>{profileTotals.unrecorded > 0 && <p className="notice">{profileTotals.unrecorded} older invoice(s) have no payment record. Paid and due totals include recorded amounts only.</p>}<div className="stats retailer-stats"><article><small>UNITS SOLD</small><h2>{profileTotals.sold.toLocaleString()}</h2><p>{profileTotals.orders} orders · {profileTotals.returned.toLocaleString()} units returned</p></article><article><small>TOTAL PAID</small><h2>{taka(profileTotals.paid)}</h2><p>Includes payments toward previous due</p></article><article><small>{profileTotals.credit > 0 ? 'CURRENT CREDIT' : 'CURRENT DUE'}</small><h2>{taka(profileTotals.credit > 0 ? profileTotals.credit : profileTotals.due)}</h2><p>{profileTotals.balance === 0 && profileTotals.unrecorded === 0 ? 'All dues cleared' : 'Recorded retailer balance'}</p></article></div><div className="section-title"><h2>Sales, returns & exchanges</h2><small>{profileInvoices.length} invoices · Net value {taka(profileTotals.net)}</small></div>{invoiceTable(profileInvoices)}<p className="muted">Previous invoices show Fully paid when current recorded due is cleared. Paid amounts and printable invoice totals preserve the original checkout records.</p></>}</>}</section>{showRetailerForm && <section id="retailer-form"><h2>{retailer.id ? 'Edit retailer' : 'Add retailer'}</h2><form onSubmit={async e => { e.preventDefault(); if (await submit({ type: 'retailer', ...retailer })) { setRetailer(blankRetailer); setShowRetailerForm(false); } }}><label>Name<input autoFocus required maxLength={160} value={retailer.name} onChange={e => setRetailer({ ...retailer, name: e.target.value })}/></label><label>Phone<input required maxLength={60} value={retailer.phone} onChange={e => setRetailer({ ...retailer, phone: e.target.value })}/></label><label>Shop name (optional)<input maxLength={160} value={retailer.shopName} onChange={e => setRetailer({ ...retailer, shopName: e.target.value })}/></label><label>Address (optional)<textarea maxLength={500} value={retailer.address} onChange={e => setRetailer({ ...retailer, address: e.target.value })}/></label><label className="check"><input type="checkbox" checked={retailer.active} onChange={e => setRetailer({ ...retailer, active: e.target.checked })}/>Active retailer</label><button disabled={busy}>Save retailer</button><button className="secondary" type="button" disabled={busy} onClick={() => { setRetailer(blankRetailer); setShowRetailerForm(false); }}>Cancel</button></form></section>}</div>}
  {tab === 'New Sale / Exchange' && <><p className="intro">Sell products, credit a previous purchase, or combine both in an exchange.</p><section><label>Retailer<select value={retailerId} onChange={e => { const id = e.target.value; setRetailerId(id); setOriginal(''); setReturns({}); setRetailerBills([]); setHistoryRetailerId(''); }}><option value="">Select retailer</option>{data.retailers.map(r => <option key={r._id} value={r._id}>{r.name}{!r.active && ' (archived; returns only)'} {r.shopName && `· ${r.shopName}`}</option>)}</select></label><h2>Products taken</h2>{lines.map((l, i) => <div className="line-editor" key={i}><label>Product / size<select value={l.productId} onChange={e => { const p = data.products.find(p => p._id === e.target.value); changeLine(i, { productId: e.target.value, price: p ? (p.unitPrice / 100).toFixed(2) : '0' }); }}><option value="">Choose product</option>{data.products.filter(p => p.active).map(p => <option key={p._id} value={p._id}>{p.name} / {p.size} · {p.stock} in stock</option>)}</select></label><label>Quantity<input type="number" min="1" max="1000000" step="1" value={l.quantity} onChange={e => changeLine(i, { quantity: Number(e.target.value) })}/></label><label>Price (৳)<input inputMode="decimal" value={l.price} onChange={e => changeLine(i, { price: e.target.value })}/></label><button className="secondary" onClick={() => setLines(lines.filter((_, index) => index !== i))}>Remove</button></div>)}<button className="secondary" onClick={() => setLines([...lines, { productId: '', quantity: 1, price: '0' }])}>Add product +</button><hr/><h2>Products returned</h2><label>Original purchase (optional)<select disabled={!retailerId} value={original} onChange={e => { setOriginal(e.target.value); setReturns({}); }}><option value="">No return</option>{retailerBills.filter(b => b.lines.some(l => l.quantity > l.returned)).map(b => <option key={b._id} value={b._id}>{b.number} · {date(b.createdAt)}</option>)}</select></label>{originalBill?.lines.map(l => <div className="return-line" key={l.productId}><span>{l.name} / {l.size}<small>Original price {taka(l.unitPrice)} · {l.quantity - l.returned} returnable</small></span><label>Return quantity<input type="number" min="0" max={l.quantity - l.returned} step="1" value={returns[l.productId] ?? 0} onChange={e => setReturns({ ...returns, [l.productId]: Number(e.target.value) })}/></label></div>)}{original && <label>Return reason (required for returns)<input ref={returnReasonInput} placeholder="e.g. Size exchange" value={reason} maxLength={160} onChange={e => setReason(e.target.value)} required/></label>}<label>Sale note (optional)<textarea value={note} maxLength={500} onChange={e => setNote(e.target.value)}/></label><div className="totals">{retailerId && (retailerHistoryReady ? <><p>Previous due <strong>{taka(previous.due)}</strong></p>{previous.credit > 0 && <p>Previous credit <strong>{taka(previous.credit)}</strong></p>}{previous.unrecorded > 0 && <p className="muted">{previous.unrecorded} older invoice(s) have no payment record. This balance includes recorded amounts only.</p>}</> : <p>Loading previous due…</p>)}<p>Products taken <strong>{taka(saleTotal)}</strong></p><p>Original-price return credit <strong>{taka(credit)}</strong></p><h2>{saleTotal - credit < 0 ? 'Credit / refund' : 'Net transaction value'}<span>{taka(Math.abs(saleTotal - credit))}</span></h2>{retailerHistoryReady && <h2>Total payable (including previous due)<span>{taka(totalPayable)}</span></h2>}{totalPayable > 0 && <><label>Paid amount (৳)<input inputMode="decimal" value={paidAmount} onChange={e => setPaidAmount(e.target.value)} aria-describedby="paid-help"/></label><small id="paid-help">Enter the full amount received, including payment toward previous due.</small>{paidPoisha === undefined ? <p>Enter a valid paid amount.</p> : paidPoisha > totalPayable ? <p>Paid amount exceeds total payable.</p> : paidPoisha === totalPayable ? <p><strong>Fully paid</strong></p> : <p>Due <strong>{taka(totalPayable - paidPoisha)}</strong></p>}</>}{retailerHistoryReady && balanceAfter !== undefined && paidPoisha !== undefined && paidPoisha <= totalPayable && <h2>{balanceAfter < 0 ? 'Credit after this transaction' : 'Total due after this transaction'}<span>{taka(Math.abs(balanceAfter))}</span></h2>}</div><p className="muted">Returned products restore stock. Previous due includes recorded transactions and return credits. Payment clears the combined previous and current due.</p>{error && <p className="error" role="alert">{error}</p>}<button disabled={busy || (!!retailerId && !retailerHistoryReady)} onClick={saveSale}>{busy ? 'Saving…' : 'Complete transaction & create invoice'}</button></section></>}
  {tab === 'Sales / Invoices' && !bill && <section><div className="section-title invoice-list-title"><h2>Sales, returns & exchanges</h2><input className="invoice-search" type="search" aria-label="Search invoices" placeholder="Search invoice, retailer or shop…" maxLength={100} value={invoiceFilters.search} onChange={e => setInvoiceFilters({ ...invoiceFilters, search: e.target.value })}/></div>
    <div className="invoice-filters">
      <label>Retailer<select value={invoiceFilters.retailerId} onChange={e => setInvoiceFilters({ ...invoiceFilters, retailerId: e.target.value })}><option value="">All retailers</option>{data.retailers.map(r => <option key={r._id} value={r._id}>{r.shopName ? `${r.name} · ${r.shopName}` : r.name}{!r.active && ' (archived)'}</option>)}</select></label>
      <fieldset><legend>Custom date range · Asia/Dhaka</legend><div className="invoice-date-range"><label>From<input type="date" value={invoiceFilters.startDate} max={invoiceFilters.endDate || undefined} onChange={e => setInvoiceFilters({ ...invoiceFilters, startDate: e.target.value })}/></label><label>To<input type="date" value={invoiceFilters.endDate} min={invoiceFilters.startDate || undefined} onChange={e => setInvoiceFilters({ ...invoiceFilters, endDate: e.target.value })}/></label></div></fieldset>
      <button className="secondary" onClick={() => setInvoiceFilters({ retailerId: '', startDate: '', endDate: '', search: '' })}>Clear filters</button>
    </div><p className="muted">Previous invoices show Fully paid when the retailer’s current recorded due is cleared.</p>
    {invoicesLoading && !bills.length ? <p role="status">Loading invoices…</p> : invoiceTable(bills)}
    {hasMore && <button disabled={invoicesLoading} className="secondary" onClick={loadOlderInvoices}>{invoicesLoading ? 'Loading…' : 'Load older invoices'}</button>}
  </section>}
  {tab === 'Expenses' && <Expenses onSave={submit}/>}
  {tab === 'Analysis' && <Analysis/>}
  {bill && <div className="invoice-overlay"><div className="invoice-actions no-print"><button className="secondary" onClick={() => setBill(undefined)}>Close invoice</button><button onClick={() => window.print()}>Print / Save as PDF</button></div><InvoiceDocument invoice={bill}/></div>}
  </main></div>;
}
