export type PaymentSnapshot = { total: number; paidAmount?: number };
export function invoicePaymentStatus(invoice: PaymentSnapshot & { dueAmount?: number; balanceAfter?: number; currentRetailerDue?: number }) {
  if (invoice.paidAmount === undefined) return { kind: 'unknown' as const, amount: 0 };
  if (invoice.currentRetailerDue === 0) return { kind: 'paid' as const, amount: 0 };
  if (invoice.balanceAfter !== undefined && invoice.balanceAfter < 0) return { kind: 'credit' as const, amount: -invoice.balanceAfter };
  const due = invoice.dueAmount ?? Math.max(0, invoice.total - invoice.paidAmount);
  return { kind: due === 0 ? 'paid' as const : 'due' as const, amount: due };
}
// Signed invoice totals already include return credits. Count each transaction once.
export function recordedBalance(invoices: PaymentSnapshot[]) {
  let balance = 0;
  let unrecorded = 0;
  for (const invoice of invoices) {
    if (invoice.paidAmount === undefined) { unrecorded++; continue; }
    balance += invoice.total - invoice.paidAmount;
  }
  return { balance, due: Math.max(0, balance), credit: Math.max(0, -balance), unrecorded };
}

export type RetailerInvoice = PaymentSnapshot & {
  lines: { quantity: number }[];
  returnLines?: { quantity: number }[];
};
export function retailerTotals(invoices: RetailerInvoice[]) {
  return {
    ...recordedBalance(invoices),
    orders: invoices.filter(i => i.lines.length > 0).length,
    sold: invoices.reduce((sum, i) => sum + i.lines.reduce((units, line) => units + line.quantity, 0), 0),
    returned: invoices.reduce((sum, i) => sum + (i.returnLines ?? []).reduce((units, line) => units + line.quantity, 0), 0),
    paid: invoices.reduce((sum, i) => sum + (i.paidAmount ?? 0), 0),
    net: invoices.reduce((sum, i) => sum + i.total, 0)
  };
}
