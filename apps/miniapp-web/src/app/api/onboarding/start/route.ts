import { NextResponse } from 'next/server';
import { OnboardError, onboardStartHandler } from '@whalepod/miniapp';
import { getOnboardDeps } from '@/lib/deps';

export const runtime = 'nodejs';

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const out = await onboardStartHandler(body, getOnboardDeps());
    return NextResponse.json(jsonSafe(out));
  } catch (err) {
    if (err instanceof OnboardError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    console.error('onboard/start failed', err);
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    return NextResponse.json({ error: 'internal', detail }, { status: 500 });
  }
}
