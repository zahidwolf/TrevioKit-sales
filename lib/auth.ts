import 'server-only';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { database } from './db';
import { BusinessError } from './business';
export const COOKIE = 'treviokit_session';
type Session = { _id: string; expiresAt: Date };
function digest(token: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 64) throw new Error('Set SESSION_SECRET to at least 64 random characters');
  return createHmac('sha256', secret).update(token).digest('hex');
}
export function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hash ?? '')) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
export async function isOwner() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const { db } = await database();
  return !!await db.collection<Session>('sessions').findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
}
export async function requireOwner() { if (!await isOwner()) throw new BusinessError('Please sign in', 401); }
export async function requireOwnerPage() { if (!await isOwner()) redirect('/login'); }
export function sameOrigin(request: Request) {
  const configured = process.env.APP_ORIGIN;
  if (!configured || request.headers.get('origin') !== new URL(configured).origin) throw new BusinessError('Request origin is not allowed', 403);
}
export async function login(username: string, password: string) {
  const { db } = await database();
  // A shared owner bucket is enforced across serverless instances and IP addresses.
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const limits = db.collection<{ _id: string; attempts: number; expiresAt: Date }>('loginLimits');
  const rate = await limits.findOneAndUpdate({ _id: `owner:${bucket}` }, { $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * 15 * 60 * 1000) } }, { upsert: true, returnDocument: 'after' });
  if ((rate?.attempts ?? 0) > 10) throw new BusinessError('Too many login attempts. Try again in 15 minutes.', 429);
  const validPassword = verifyPassword(password, process.env.OWNER_PASSWORD_HASH ?? '');
  if (!validPassword || username !== process.env.OWNER_USERNAME) throw new BusinessError('Invalid username or password', 401);
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await db.collection<Session>('sessions').insertOne({ _id: digest(token), expiresAt });
  (await cookies()).set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', expires: expiresAt });
}
export async function logout() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE)?.value;
  if (token) { const { db } = await database(); await db.collection<Session>('sessions').deleteOne({ _id: digest(token) }); }
  cookieStore.delete(COOKIE);
}
