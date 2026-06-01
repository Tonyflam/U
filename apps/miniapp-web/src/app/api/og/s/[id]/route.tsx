/**
 * Dynamic OG image for /s/[id]. Resolves the short id to its HMAC
 * token via Redis, then internally redirects to the canonical
 * /api/og/share/trade?t=<token> renderer.
 *
 * We use a redirect (rather than re-rendering inline) so the heavy
 * Satori image code lives in exactly one place.
 */
import { NextResponse } from 'next/server';
import { resolveShortLink } from '@/lib/shortLinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const token = await resolveShortLink(params.id);
  const url = new URL(req.url);
  const target = new URL('/api/og/share/trade', url);
  if (token) target.searchParams.set('t', token);
  return NextResponse.redirect(target, 307);
}
