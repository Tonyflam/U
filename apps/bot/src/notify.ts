/**
 * Pure fill-notification renderer.
 *
 * The Order Router (lands wired in U16) writes one `MirrorFillEvent` per
 * successfully placed/filled mirror order to a notifications queue. The TG
 * bot adapter picks each one up and calls `renderFillNotification` to turn
 * the event into a `Reply` (the same shape used by command handlers).
 *
 * Keeping the renderer pure means:
 *  - Notification text is deterministic and snapshot-testable.
 *  - User preferences (verbosity / PnL display / fee display) can be A/B'd
 *    without touching transport.
 *  - Property tests can assert invariants like "fee line never appears when
 *    showFee=false" across any input.
 */
import { z } from 'zod';
import { Address, Coin, FeeTenthsBp, Side } from '@whalepod/schema';
import type { Reply } from './handlers.js';

type SideValue = z.infer<typeof Side>;

const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/u, 'must be a decimal string');
const PositiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/u, 'must be a non-negative decimal string');

export const MirrorFillEvent = z.object({
  /** `${whaleFillId}:${subscriberId}` — same key used to dedupe in the router. */
  idempotencyKey: z.string().min(3),
  /** Whale wallet whose fill we mirrored. */
  whaleAddress: Address,
  /** Optional human alias the user (or curator) set for this whale. */
  whaleAlias: z.string().min(1).max(64).optional(),
  coin: Coin,
  side: Side,
  /** User's executed price (decimal string). */
  px: PositiveDecimalString,
  /** User's executed size (decimal string). */
  sz: PositiveDecimalString,
  /** Notional in USD (decimal string). */
  notionalUsd: PositiveDecimalString,
  /** Fee charged to the user, in tenths of a bp. Bounded 0..100 by schema. */
  builderFeeTenthsBp: FeeTenthsBp,
  /** Fee charged to the user, in USD (decimal string). */
  builderFeeUsd: PositiveDecimalString,
  /** Realized PnL on this fill if it closes/reduces an existing position. Signed decimal. */
  realizedPnlUsd: DecimalString.optional(),
  /** Server timestamp (ms). */
  ts: z.number().int().nonnegative(),
});
export type MirrorFillEvent = z.infer<typeof MirrorFillEvent>;

export interface NotifyPrefs {
  /** If true, the consumer skips Telegram delivery entirely. Default false. */
  readonly muted?: boolean;
  /** If false, suppress the fee line. Default true. */
  readonly showFee?: boolean;
  /** If false, suppress realized PnL even when present. Default true. */
  readonly showPnl?: boolean;
  /** If true, output a tighter one-line summary. Default false. */
  readonly compact?: boolean;
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function sideLabel(side: SideValue): 'BUY' | 'SELL' {
  return side === 'B' ? 'BUY' : 'SELL';
}

function fmtFeeBps(tenthsBp: number): string {
  return `${(tenthsBp / 10).toFixed(1)} bps`;
}

function fmtUsd(s: string): string {
  // s is already a decimal string; just normalize to 2dp without parsing as float
  // when we can. Best-effort: round via Number for display only.
  const n = Number(s);
  if (!Number.isFinite(n)) return `$${s}`;
  const abs = Math.abs(n);
  const fixed = abs >= 1 ? abs.toFixed(2) : abs.toFixed(4);
  return `${n < 0 ? '-' : ''}$${fixed}`;
}

function pnlEmoji(pnl: string): string {
  const n = Number(pnl);
  if (!Number.isFinite(n) || n === 0) return '·';
  return n > 0 ? '🟢' : '🔴';
}

export function renderFillNotification(event: MirrorFillEvent, prefs: NotifyPrefs = {}): Reply {
  const showFee = prefs.showFee !== false;
  const showPnl = prefs.showPnl !== false;
  const whaleLabel = event.whaleAlias ?? fmtAddr(event.whaleAddress);

  if (prefs.compact === true) {
    const parts = [
      `Mirrored ${sideLabel(event.side)} ${event.sz} ${event.coin} @ ${event.px}`,
      `(${whaleLabel})`,
    ];
    if (showFee) parts.push(`fee ${fmtFeeBps(event.builderFeeTenthsBp)}`);
    if (showPnl && event.realizedPnlUsd !== undefined) {
      parts.push(`${pnlEmoji(event.realizedPnlUsd)} ${fmtUsd(event.realizedPnlUsd)}`);
    }
    return { text: parts.join(' · ') };
  }

  const lines: string[] = [
    `${sideLabel(event.side)} ${event.sz} ${event.coin} @ ${event.px}`,
    `Mirrored from ${whaleLabel}`,
    `Notional: ${fmtUsd(event.notionalUsd)}`,
  ];
  if (showFee) {
    lines.push(`Fee: ${fmtUsd(event.builderFeeUsd)} (${fmtFeeBps(event.builderFeeTenthsBp)})`);
  }
  if (showPnl && event.realizedPnlUsd !== undefined) {
    lines.push(`Realized PnL: ${pnlEmoji(event.realizedPnlUsd)} ${fmtUsd(event.realizedPnlUsd)}`);
  }
  return { text: lines.join('\n') };
}
