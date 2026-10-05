import { NextResponse } from 'next/server';
import { requireOwner, sameOrigin } from '@/lib/auth';
import { database } from '@/lib/db';
import { execute } from '@/lib/business';
import { body, failure } from '@/lib/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { sameOrigin(request); await requireOwner(); const input = await body(request); const { db, client } = await database(); const result = await execute(db, client, request.headers.get('idempotency-key') ?? '', input); return NextResponse.json(result); } catch (error) { return failure(error); }
}
