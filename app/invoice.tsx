import type { Invoice } from '@/lib/business';
import { taka } from '@/lib/validation';

type PrintableInvoice = Omit<Invoice, 'createdAt'> & { createdAt: string };
type InvoiceLine = { productId: string; name: string; size: string; quantity: number; unitPrice: number };

function InvoiceLines({ title, lines }: { title: string; lines: InvoiceLine[] }) {
  return <div className="invoice-section">
    <h2>{title}</h2>
    <table className="invoice-lines">
      <colgroup><col className="line-number"/><col/><col className="line-size"/><col className="line-quantity"/><col className="line-price"/><col className="line-amount"/></colgroup>
      <thead><tr><th>No.</th><th>Product</th><th>Size</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={line.productId}>
        <td>{String(index + 1).padStart(2, '0')}</td><td>{line.name}</td><td>{line.size}</td><td>{line.quantity}</td><td>{taka(line.unitPrice)}</td><td>{taka(line.quantity * line.unitPrice)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function InvoiceDocument({ invoice: bill }: { invoice: PrintableInvoice }) {
  const type = bill.returnLines ? bill.lines.length ? 'Exchange' : 'Return' : 'Sale';
  const productsTotal = bill.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const returnCredit = (bill.returnLines ?? []).reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const due = bill.dueAmount ?? Math.max(0, bill.total - (bill.paidAmount ?? 0));
  const previousBalance = bill.openingBalance ?? 0;
  const date = new Date(bill.createdAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' });

  return <article className="invoice" aria-label={`${type} invoice ${bill.number}`}>
    <div className="invoice-heading">
      <div className="invoice-brand">TrevioKit</div>
      <div className="invoice-metadata">
        <h1>{type} Invoice</h1>
        <dl><dt>Invoice No.</dt><dd className="invoice-number">{bill.number}</dd><dt>Date</dt><dd>{date}</dd></dl>
      </div>
    </div>
    <div className="invoice-recipient">
      <p className="bill-to">Bill To:</p>
      <h2>{bill.retailer.shopName || 'Shop name not provided'}</h2>
    </div>
    {bill.lines.length > 0 && <InvoiceLines title="Products Taken" lines={bill.lines}/>}
    {bill.returnLines && <>
      <InvoiceLines title="Products Returned" lines={bill.returnLines}/>
      {bill.originalInvoiceId && <p className="invoice-original">Original invoice: <strong>{bill.originalInvoiceNumber ?? `TK-${bill.originalInvoiceId.toUpperCase()}`}</strong></p>}
    </>}
    <div className="invoice-summary">
      <dl>
        <dt>Products total</dt><dd>{taka(productsTotal)}</dd>
        {returnCredit > 0 && <><dt>Return credit</dt><dd>−{taka(returnCredit)}</dd></>}
        <dt className="summary-net">{bill.total < 0 ? 'Net credit / refund' : 'Net amount'}</dt><dd className="summary-net">{taka(Math.abs(bill.total))}</dd>
        {previousBalance !== 0 && <>
          <dt>{previousBalance < 0 ? 'Previous credit' : 'Previous due'}</dt><dd>{taka(Math.abs(previousBalance))}</dd>
          <dt className="summary-emphasis">Total payable</dt><dd className="summary-emphasis">{taka(bill.totalPayable ?? Math.max(0, previousBalance + bill.total))}</dd>
        </>}
        {bill.paidAmount === undefined ? <><dt>Paid</dt><dd>Not recorded</dd><dt>Due</dt><dd>Not recorded</dd></> : <>
          <dt>Paid</dt><dd>{taka(bill.paidAmount)}</dd>
          {bill.balanceAfter !== undefined && bill.balanceAfter < 0 ? <><dt className="summary-emphasis">Remaining credit</dt><dd className="summary-emphasis">{taka(-bill.balanceAfter)}</dd></> : <>
            <dt className="summary-emphasis">{previousBalance !== 0 ? 'Total remaining due' : 'Due'}</dt><dd className="summary-emphasis">{taka(due)}</dd>
          </>}
        </>}
      </dl>
      {bill.paidAmount !== undefined && due === 0 && (bill.balanceAfter ?? 0) >= 0 && <p className="invoice-payment-status">Fully paid</p>}
      {!!bill.previousUnrecorded && <p className="invoice-disclaimer">Older invoices without payment records are excluded from this balance.</p>}
    </div>
    {bill.note && <p className="invoice-note">Note: {bill.note}</p>}
    <footer className="invoice-footer">
      <div className="invoice-contact"><span>www.treviokit.com</span><span>Middle Badda, Dhaka</span><span>01858057515</span></div>
      <p>Thank you for your business.</p>
    </footer>
  </article>;
}
