import { z } from 'zod';
export const LIMIT = 1_000_000_000_000;
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid date');
const id = z.string().uuid();
const text = z.string().trim().min(1).max(160);
const money = z.number().int().min(0).max(LIMIT);
const quantity = z.number().int().min(1).max(1_000_000);
const lines = z.array(z.object({ productId: id, quantity, unitPrice: money }).strict()).min(1).max(100).refine(v => new Set(v.map(l => l.productId)).size === v.length, 'Combine duplicate products into one line');
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('expense'), description: text, amount: money.min(1), expenseDate: calendarDate }).strict(),
  z.object({ type: z.literal('product'), id: id.optional(), name: text, size: text, initialStock: z.number().int().min(0).max(1_000_000).optional(), unitPrice: money, imageUrl: z.union([z.literal(''), z.url().max(2048).refine(v => v.startsWith('https://'), 'Use an HTTPS image URL')]), active: z.boolean() }).strict().refine(v => !v.id || v.initialStock === undefined, 'Use a stock adjustment to change existing stock'),
  z.object({ type: z.literal('retailer'), id: id.optional(), name: text, phone: z.string().trim().min(1).max(60), shopName: z.string().trim().max(160), address: z.string().trim().max(500), active: z.boolean() }).strict(),
  z.object({ type: z.literal('stock'), productId: id, delta: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0), reason: text }).strict(),
  z.object({ type: z.literal('sale'), retailerId: id, lines, paidAmount: money.optional(), expectedBalance: z.number().int().min(-LIMIT).max(LIMIT).optional(), note: z.string().trim().max(500) }).strict(),
  z.object({ type: z.literal('return'), retailerId: id, invoiceId: id, lines: z.array(z.object({ productId: id, quantity }).strict()).min(1).max(100).refine(v => new Set(v.map(l => l.productId)).size === v.length, 'Duplicate return product'), reason: z.string().trim().min(1, 'Return reason is required.').max(160), paidAmount: money.optional(), expectedBalance: z.number().int().min(-LIMIT).max(LIMIT).optional(), exchangeLines: lines.optional() }).strict()
]);
export type Operation = z.infer<typeof operationSchema>;
export function total(lines: { quantity: number; unitPrice: number }[]) {
  const amount = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  if (!Number.isSafeInteger(amount) || amount > LIMIT) throw new Error('Invoice total exceeds the supported money limit');
  return amount;
}
export function parseTaka(value: string): number {
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(value)) throw new Error('Enter taka with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (amount > LIMIT) throw new Error('Amount is too large');
  return amount;
}
export function taka(poisha: number) { return `৳${(poisha / 100).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// Return actionable field errors without echoing request values or credentials.
export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request. Check all fields.';
  const field = String(issue.path.at(-1) ?? '');
  const lineIndex = typeof issue.path[1] === 'number' ? ` (line ${issue.path[1] + 1})` : '';
  if (field === 'amount') return 'Enter an expense amount greater than zero with at most two decimal places.';
  if (field === 'expenseDate') return 'Enter a valid expense date.';
  if (field === 'description') return 'Enter a description between 1 and 160 characters.';
  if (field === 'reason') return issue.code === 'too_small' ? (issue.message === 'Return reason is required.' ? issue.message : 'A reason is required.') : 'Enter a reason between 1 and 160 characters.';
  if (field === 'quantity') return `Enter a whole quantity between 1 and 1,000,000${lineIndex}.`;
  if (field === 'productId') return `Choose a valid product${lineIndex}.`;
  if (field === 'retailerId') return 'Select a valid retailer.';
  if (field === 'invoiceId') return 'Select the original purchase for this return.';
  if (field === 'paidAmount') return 'Enter a valid non-negative paid amount with no fractional poisha.';
  if (field === 'unitPrice') return `Enter a valid non-negative selling price${lineIndex}.`;
  if ((field === 'lines' || field === 'exchangeLines') && issue.code === 'custom') return 'Combine duplicate products into a single line.';
  return 'Invalid request. Check all fields.';
}
