import { NextResponse } from 'next/server';
import { z } from 'zod';
import { login, sameOrigin } from '@/lib/auth';
import { body, failure } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    sameOrigin(request);

    const data = z
      .object({
        username: z.string().max(160),
        password: z.string().min(1).max(256),
      })
      .strict()
      .parse(await body(request));

    await login(data.username, data.password);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    return failure(error);
  }
}
