/**
 * Pure watch-alert renderer.
 *
 * Turns a `WatchFillEvent` (whale fill seen by ws-consumer, fanned out per
 * watcher) into a Telegram `Reply`. This is the conversion engine of the
 * /watch funnel: every free alert carries a "mirror this whale" CTA that
 * deep-links into the bot's whale-intent /start flow.
 *
 * Pure on purpose — snapshot-testable, no transport, no DB.
 */
import { findCuratedWhaleBySlug, whaleSlug } from '@whalepod/sdk';
import type { WatchFillEvent } from '@whalepod/ws-consumer';
import type { Reply } from './handlers.js';

export interface WatchAlertOpts {
  /** Telegram bot @username (no leading `@`) for the mirror deep link. */
  readonly botUsername: string;
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtNotional(px: string, sz: string): string | null {
  const p = Number(px);
  const s = Number(sz);
  if (!Number.isFinite(p) || !Number.isFinite(s)) return null;
  const n = p * s;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function renderWatchAlert(event: WatchFillEvent, opts: WatchAlertOpts): Reply {
  const label = event.whaleAlias ?? fmtAddr(event.whaleAddress);
  const action = event.side === 'B' ? 'BOUGHT' : 'SOLD';
  const emoji = event.side === 'B' ? '🟢' : '🔴';
  const notional = fmtNotional(event.px, event.sz);

  const lines = [`${emoji} ${label} just ${action} ${event.sz} ${event.coin} @ ${event.px}`];
  if (notional !== null) lines.push(`≈ ${notional} notional`);
  lines.push(
    '',
    `⚡ Mirror this whale automatically — non-custodial, hard per-trade size cap:`,
    `/follow ${event.whaleAddress} 50`,
    '',
    `/unwatch ${event.whaleAddress} — stop these alerts`,
  );

  // Curated whales get a one-tap deep link into the whale-intent /start
  // funnel (works for both new and onboarded users). Non-curated whales
  // fall back to the generic watch-channel onboard link.
  const curated = event.whaleAlias ? findCuratedWhaleBySlug(whaleSlug(event.whaleAlias)) : null;
  const startParam = curated ? `src_whale_${whaleSlug(curated.alias)}` : 'src_watch';
  const url = `https://t.me/${opts.botUsername}?start=${startParam}`;

  return {
    text: lines.join('\n'),
    buttons: [[{ label: `⚡ Mirror ${label}`, url }]],
  };
}
