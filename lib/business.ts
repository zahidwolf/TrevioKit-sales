import { createHash, randomUUID } from 'node:crypto';
import { MongoServerError, type Db, type MongoClient, type ClientSession } from 'mongodb';
import { operationSchema, total, LIMIT, type Operation } from './validation';
export class BusinessError extends Error { constructor(message: string, public status = 409) { super(message); } }
export type Product = { _id: string; name: string; size: string; unitPrice: number; imageUrl: string; stock: number; active: boolean };
export type Retailer = { _id: string; name: string; phone: string; shopName: string; address: string; active: boolean };
export type Line = { productId: string; name: string; size: string; quantity: number; unitPrice: number; returned: number };
export type Invoice = { _id: string; number: string; retailerId: string; retailer: Retailer; lines: Line[]; total: number; note: string; createdAt: Date; exchangeReturnId?: string; returnLines?: ReturnRecord['lines']; originalInvoiceId?: string; originalInvoiceNumber?: string; grossSale?: number; credit?: number; paidAmount?: number; dueAmount?: number; openingBalance?: number; balanceAfter?: number; totalPayable?: number; previousUnrecorded?: number };
export type ReturnRecord = { _id: string; invoiceId: string; lines: { productId: string; quantity: number; unitPrice: number; name: string; size: string }[]; refund: number; reason: string; restock: boolean; createdAt: Date; exchangeInvoiceId?: string; netDue: number };
export type Expense = { _id: string; description: string; amount: number; expenseDate: string; createdAt: Date };
export type History = { _id: string; type: string; detail: unknown; createdAt: Date };
type InvoiceCounter = { _id: string; sequence: number };

async function nextInvoiceNumber(db: Db, session: ClientSession) {
  const counter = await db.collection<InvoiceCounter>('counters').findOneAndUpdate(
    { _id: 'invoice' }, { $inc: { sequence: 1 } }, { session, returnDocument: 'after' }
  );
  if (!counter || !Number.isSafeInteger(counter.sequence) || counter.sequence < 1) throw new BusinessError('Invoice number configuration is invalid', 500);
  return `TK-${String(counter.sequence).padStart(6, '0')}`;
}

type Receipt = { _id: string; fingerprint: string; result: { id: string; invoiceId?: string; netDue?: number }; createdAt: Date };
export async function execute(db: Db, client: MongoClient, key: string, input: unknown) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw new BusinessError('A submission UUID is required', 400);
  const operation = operationSchema.parse(input);
  const fingerprint = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
  const receipts = db.collection<Receipt>('submissions');
  const match = (receipt: Receipt) => { if (receipt.fingerprint !== fingerprint) throw new BusinessError('Submission key already used for different data'); return receipt.result; };
  const old = await receipts.findOne({ _id: key });
  if (old) return match(old);
  if (operation.type === 'sale' || operation.type === 'return') {
    // Create the singleton before starting a transaction. Concurrent first-use
    // upserts may race on _id; the winner's document is shared by both requests.
    try {
      await db.collection<InvoiceCounter>('counters').updateOne({ _id: 'invoice' }, { $setOnInsert: { sequence: 0 } }, { upsert: true });
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    }
  }
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const existing = await receipts.findOne({ _id: key }, { session });
      if (existing) return match(existing);
      const result = await apply(db, session, operation);
      await receipts.insertOne({ _id: key, fingerprint, result, createdAt: new Date() }, { session });
      await db.collection<History>('history').insertOne({ _id: randomUUID(), type: operation.type, detail: { operation, result }, createdAt: new Date() }, { session });
      return result;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const committed = await receipts.findOne({ _id: key });
      if (committed) return match(committed);
      throw new BusinessError('This product name and size already exist');
    }
    throw error;
  } finally { await session.endSession(); }
}
async function apply(db: Db, session: ClientSession, op: Operation): Promise<Receipt['result']> {
  const products = db.collection<Product>('products');
  const retailers = db.collection<Retailer>('retailers');
  const invoices = db.collection<Invoice>('invoices');
  const options = { session };
  if (op.type === 'expense') {
    const id = randomUUID();
    await db.collection<Expense>('expenses').insertOne({ _id: id, description: op.description, amount: op.amount, expenseDate: op.expenseDate, createdAt: new Date() }, options);
    return { id };
  }
  if (op.type === 'product') {
    const { type: _type, id, initialStock, ...fields } = op;
    const keys = { nameKey: fields.name.toLowerCase(), sizeKey: fields.size.toLowerCase() };
    const productId = id ?? randomUUID();
    if (id) { if (!(await products.updateOne({ _id: id }, { $set: { ...fields, ...keys } }, options)).matchedCount) throw new BusinessError('Product not found', 404); }
    else await products.insertOne({ _id: productId, ...fields, ...keys, stock: initialStock ?? 0 }, options);
    return { id: productId };
  }
  if (op.type === 'retailer') {
    const { type: _type, id, ...fields } = op;
    const retailerId = id ?? randomUUID();
    if (id) { if (!(await retailers.updateOne({ _id: id }, { $set: fields }, options)).matchedCount) throw new BusinessError('Retailer not found', 404); }
    else await retailers.insertOne({ _id: retailerId, ...fields }, options);
    return { id: retailerId };
  }
  if (op.type === 'stock') {
    const updated = await products.updateOne({ _id: op.productId, stock: { $gte: Math.max(0, -op.delta), $lte: 1_000_000_000 - Math.max(0, op.delta) } }, { $inc: { stock: op.delta } }, options);
    if (!updated.matchedCount) throw new BusinessError('Stock adjustment would exceed limits or product is missing');
    return { id: op.productId };
  }
  // All checkouts for a retailer write this document before reading their balance.
  // A concurrent checkout conflicts and retries against the newly committed history.
  const locked = await retailers.updateOne({ _id: op.retailerId }, { $inc: { settlementVersion: 1 } }, options);
  if (!locked.matchedCount) throw new BusinessError(op.type === 'return' ? 'Original invoice does not belong to this retailer' : 'Retailer not found', 404);
  const [account] = await invoices.aggregate<{ balance: number; unrecorded: number }>([
    { $match: { retailerId: op.retailerId } },
    { $group: {
      _id: null,
      balance: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$paidAmount', null] }, null] }, { $subtract: ['$total', '$paidAmount'] }, 0] } },
      unrecorded: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$paidAmount', null] }, null] }, 1, 0] } }
    } }
  ], options).toArray();
  const openingBalance = account?.balance ?? 0;
  if (op.expectedBalance !== undefined && op.expectedBalance !== openingBalance) throw new BusinessError('Retailer balance changed. Review the refreshed previous due and submit again.', 409);
  if (!Number.isSafeInteger(openingBalance) || Math.abs(openingBalance) > LIMIT) throw new BusinessError('Retailer balance exceeds the supported money limit', 400);
  async function sale(retailerId: string, raw: { productId: string; quantity: number; unitPrice: number }[], note: string, exchangeReturnId?: string) {
    const retailer = await retailers.findOne({ _id: retailerId, active: true }, options);
    if (!retailer) throw new BusinessError('Choose an active retailer');
    let amount: number;
    try { amount = total(raw); } catch { throw new BusinessError('Invoice value exceeds the supported money limit', 400); }
    const lines: Line[] = [];
    for (const line of raw) {
      const product = await products.findOneAndUpdate({ _id: line.productId, active: true, stock: { $gte: line.quantity } }, { $inc: { stock: -line.quantity } }, { ...options, returnDocument: 'before' });
      if (!product) throw new BusinessError('Insufficient stock or inactive product');
      lines.push({ ...line, name: product.name, size: product.size, returned: 0 });
    }
    const id = randomUUID();
    await invoices.insertOne({ _id: id, number: await nextInvoiceNumber(db, session), retailerId, retailer, lines, total: amount, note, createdAt: new Date(), ...(exchangeReturnId ? { exchangeReturnId } : {}) }, options);
    return { id, amount };
  }
  function paymentFields(net: number, paidAmount?: number) {
    if (paidAmount === undefined) return {};
    const totalPayable = Math.max(0, openingBalance + net);
    if (!Number.isSafeInteger(totalPayable) || totalPayable > LIMIT) throw new BusinessError('Total payable exceeds the supported money limit', 400);
    if (paidAmount > totalPayable) throw new BusinessError('Paid amount cannot exceed total payable, including previous due. Refresh the retailer history if another transaction was completed.', 409);
    const balanceAfter = openingBalance + net - paidAmount;
    if (!Number.isSafeInteger(balanceAfter) || Math.abs(balanceAfter) > LIMIT) throw new BusinessError('Retailer balance exceeds the supported money limit', 400);
    return { paidAmount, dueAmount: Math.max(0, balanceAfter), openingBalance, balanceAfter, totalPayable, previousUnrecorded: account?.unrecorded ?? 0 };
  }
  if (op.type === 'sale') {
    const result = await sale(op.retailerId, op.lines, op.note);
    const payment = paymentFields(result.amount, op.paidAmount);
    if (op.paidAmount !== undefined) await invoices.updateOne({ _id: result.id }, { $set: payment }, options);
    return { id: result.id, invoiceId: result.id };
  }
  const invoice = await invoices.findOne({ _id: op.invoiceId }, options);
  if (!invoice || invoice.retailerId !== op.retailerId) throw new BusinessError('Original invoice does not belong to this retailer', 404);
  const currentRetailer = await retailers.findOne({ _id: invoice.retailerId }, options);
  if (!currentRetailer) throw new BusinessError('Retailer not found', 404);
  const returned: ReturnRecord['lines'] = [];
  for (const line of op.lines) {
    const original = invoice.lines.find(l => l.productId === line.productId);
    if (!original || line.quantity > original.quantity - original.returned) throw new BusinessError('Return exceeds the remaining sold quantity');
    original.returned += line.quantity;
    returned.push({ ...line, unitPrice: original.unitPrice, name: original.name, size: original.size });
    {
      const updated = await products.updateOne({ _id: line.productId, stock: { $lte: 1_000_000_000 - line.quantity } }, { $inc: { stock: line.quantity } }, options);
      if (!updated.matchedCount) throw new BusinessError('Cannot restock this product');
    }
  }
  // Writing the invoice creates a conflict for concurrent returns, triggering driver retry.
  await invoices.updateOne({ _id: invoice._id }, { $set: { lines: invoice.lines } }, options);
  const id = randomUUID();
  const refund = total(returned);
  const replacement = op.exchangeLines ? await sale(invoice.retailerId, op.exchangeLines, `Exchange for ${invoice.number}`, id) : undefined;
  const netDue = (replacement?.amount ?? 0) - refund;
  const payment = paymentFields(netDue, op.paidAmount);
  const newInvoiceId = replacement?.id ?? randomUUID();
  if (replacement) await invoices.updateOne({ _id: newInvoiceId }, { $set: { ...payment, total: netDue, grossSale: replacement.amount, credit: refund, returnLines: returned, originalInvoiceId: invoice._id, originalInvoiceNumber: invoice.number, note: op.reason } }, options);
  else await invoices.insertOne({ _id: newInvoiceId, number: await nextInvoiceNumber(db, session), retailerId: invoice.retailerId, retailer: currentRetailer, lines: [], ...payment, returnLines: returned, originalInvoiceId: invoice._id, originalInvoiceNumber: invoice.number, total: netDue, grossSale: 0, credit: refund, note: op.reason, createdAt: new Date(), exchangeReturnId: id }, options);
  await db.collection<ReturnRecord>('returns').insertOne({ _id: id, invoiceId: invoice._id, lines: returned, refund, reason: op.reason, restock: true, createdAt: new Date(), netDue, exchangeInvoiceId: newInvoiceId }, options);
  return { id, invoiceId: newInvoiceId, netDue };
}
