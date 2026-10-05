import { NextResponse } from 'next/server';
import { logout, requireOwner, sameOrigin } from '@/lib/auth';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try { sameOrigin(request); await requireOwner(); await logout(); return NextResponse.json({ ok: true }); } catch (error) { return failure(error); }
}
