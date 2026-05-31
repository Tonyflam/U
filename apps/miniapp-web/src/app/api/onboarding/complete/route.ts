import { NextResponse } from 'next/server';
import { OnboardError, onboardCompleteHandler } from '@whalepod/miniapp';
import { getOnboardDeps } from '@/lib/deps';

export const runtime = 'nodejs';

async function notifyBot(tgUserId: string | undefined): Promise<void> {
  if (!tgUserId) return;
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    console.warn('telegram notify skipped: TELEGRAM_BOT_TOKEN not set');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgUserId,
        text:
          "✅ Wallet connected & authorized.\n\nYou're ready to mirror whales. Try /whales to browse, or /wallet to see your setup.",
      }),
    });
    if (!res.ok) {
      console.error('telegram notify failed', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('telegram notify error', e);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const out = await onboardCompleteHandler(body, getOnboardDeps());
    const tgUserId =
      body && typeof body === 'object' && 'tgUserId' in body
        ? String((body as { tgUserId: unknown }).tgUserId)
        : undefined;
    await notifyBot(tgUserId);
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof OnboardError) {
      const status =
        err.code === 'signature_mismatch' ? 401 : err.code === 'provisional_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error('onboard/complete failed', err);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    return NextResponse.json({ error: 'internal', detail }, { status: 500 });
  }
}
