import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { BusinessError } from './business';
import { validationMessage } from './validation';
export function failure(error: unknown) {
  if (error instanceof BusinessError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: validationMessage(error) }, { status: 400 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON request.' }, { status: 400 });
  // Never expose connection strings, driver errors or environment variables to clients.
  return NextResponse.json({ error: 'The operation could not be completed. Check server configuration or retry with the same submission.' }, { status: 503 });
}
export async function body(request: Request) {
  const content = await request.text();
  if (content.length > 65536) throw new BusinessError('Request is too large', 413);
  return JSON.parse(content);
}
