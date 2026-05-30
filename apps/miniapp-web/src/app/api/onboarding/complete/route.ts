import { NextResponse } from 'next/server';
import { OnboardError, onboardCompleteHandler } from '@whalepod/miniapp';
import { getOnboardDeps } from '@/lib/deps';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const out = await onboardCompleteHandler(body, getOnboardDeps());
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof OnboardError) {
      const status =
        err.code === 'signature_mismatch' ? 401 : err.code === 'provisional_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error('onboard/complete failed', err);
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    return NextResponse.json({ error: 'internal', detail }, { status: 500 });
  }
}
