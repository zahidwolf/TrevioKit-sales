import 'server-only';
import { MongoClient } from 'mongodb';
const cache = globalThis as typeof globalThis & { mongoPromise?: Promise<MongoClient>; indexesPromise?: Promise<void> };
export async function database() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new Error('MongoDB environment is not configured');
  cache.mongoPromise ??= new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 10000
  }).connect().catch(error => { cache.mongoPromise = undefined; throw error; });
  const client = await cache.mongoPromise;
  const db = client.db(process.env.MONGODB_DB);
  cache.indexesPromise ??= (async () => {
    await db.collection('products').createIndex({ nameKey: 1, sizeKey: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('loginLimits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('invoices').createIndex({ number: 1 }, { unique: true });
    await db.collection('invoices').createIndex({ createdAt: -1 });
    await db.collection('invoices').createIndex({ retailerId: 1, createdAt: -1 });
    await db.collection('expenses').createIndex({ expenseDate: -1, createdAt: -1 });
    await db.collection('history').createIndex({ createdAt: -1 });
    await db.collection('returns').createIndex({ invoiceId: 1 });
  })().catch(error => { cache.indexesPromise = undefined; throw error; });
  await cache.indexesPromise;
  return { db, client };
}
