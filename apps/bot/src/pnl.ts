/**
 * Pure PnL renderer for /pnl.
 *
 * The /pnl command reports, per whale the user mirrors:
 *   - realized PnL (sum of closed-leg PnL recorded on fills)
 *   - unrealized PnL (mark-to-market of the still-open net position)
 *   - builder fees paid (cumulative cost of mirroring)
 * plus a totals line across all whales.
 *
 * This module is the renderer + the math. Position aggregation uses signed
 * USD-cost accounting (average cost basis): a fill increases or decreases
 * `netSz` and `costBasisUsd` consistently with the sign of the trade.
 *
 * Why pure: the live /pnl command will join (fills table) × (mark prices)
 * × (user prefs); the renderer must be deterministic so we can snapshot
 * both green-day and red-day flows without booting Redis or Postgres.
 */
import { z } from 'zod';
import { Address, Coin, FeeTenthsBp, Side } from '@whalepod/schema';
import type { Reply } from './handlers.js';

type SideValue = z.infer<typeof Side>;
type CoinValue = z.infer<typeof Coin>;

const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/u, 'must be a decimal string');
const PositiveDecimalString = z.string().regex(/^\d+(\.\d+)?$/u, 'must be non-negative decimal');

/**
 * One mirrored fill as stored by the Order Router. Reused shape for /pnl
 * aggregation. Realized PnL is what the fill itself crystallized (e.g. the
 * close leg of a long); open positions roll forward via cost basis.
 */
export const PnlFill = z.object({
  whaleAddress: Address,
  whaleAlias: z.string().min(1).max(64).optional(),
  coin: Coin,
  side: Side,
  px: PositiveDecimalString,
  sz: PositiveDecimalString,
  notionalUsd: PositiveDecimalString,
  builderFeeUsd: PositiveDecimalString,
  builderFeeTenthsBp: FeeTenthsBp,
  realizedPnlUsd: DecimalString.optional(),
  ts: z.number().int().nonnegative(),
});
export type PnlFill = z.infer<typeof PnlFill>;

/** `(coin) => decimal-string mark price`. Return null if unavailable. */
export type MarkPriceFn = (coin: CoinValue) => string | null;

export interface WhaleSummary {
  readonly whaleAddress: string;
  readonly whaleAlias: string | null;
  readonly realizedUsd: number;
  readonly unrealizedUsd: number;
  readonly feesUsd: number;
  /** Coins still net-open (for footnote display). */
  readonly openCoins: readonly CoinValue[];
}

export interface PnlSummary {
  readonly perWhale: readonly WhaleSummary[];
  readonly totalRealizedUsd: number;
  readonly totalUnrealizedUsd: number;
  readonly totalFeesUsd: number;
}

interface Position {
  netSz: number; // signed: + long, - short
  costBasisUsd: number; // signed; same sign as netSz when open
}

function applyFill(
  pos: Position,
  side: SideValue,
  sz: number,
  px: number,
  realized?: number,
): {
  next: Position;
  realizedDelta: number;
} {
  // If realizedPnlUsd was provided on the fill, trust it — the Order Router
  // already computed it against the actual entry leg. Otherwise treat the
  // fill as pure cost-basis movement.
  const signed = side === 'B' ? sz : -sz;
  const next: Position = {
    netSz: pos.netSz + signed,
    costBasisUsd: pos.costBasisUsd + signed * px,
  };
  return { next, realizedDelta: realized ?? 0 };
}

function unrealizedFor(pos: Position, mark: number): number {
  // mark-to-market value = netSz * mark; unrealized = value - costBasis
  return pos.netSz * mark - pos.costBasisUsd;
}

export function summarizePnl(fills: readonly PnlFill[], markPrice: MarkPriceFn): PnlSummary {
  // group by whale, then by coin
  const byWhale = new Map<
    string,
    {
      whaleAlias: string | null;
      realized: number;
      fees: number;
      positions: Map<CoinValue, Position>;
    }
  >();

  for (const f of fills) {
    let entry = byWhale.get(f.whaleAddress);
    if (!entry) {
      entry = {
        whaleAlias: f.whaleAlias ?? null,
        realized: 0,
        fees: 0,
        positions: new Map(),
      };
      byWhale.set(f.whaleAddress, entry);
    } else if (entry.whaleAlias === null && f.whaleAlias !== undefined) {
      entry.whaleAlias = f.whaleAlias;
    }
    const sz = Number(f.sz);
    const px = Number(f.px);
    const fee = Number(f.builderFeeUsd);
    const realized = f.realizedPnlUsd !== undefined ? Number(f.realizedPnlUsd) : undefined;
    const pos = entry.positions.get(f.coin) ?? { netSz: 0, costBasisUsd: 0 };
    const { next, realizedDelta } = applyFill(pos, f.side, sz, px, realized);
    entry.positions.set(f.coin, next);
    entry.realized += realizedDelta;
    entry.fees += fee;
  }

  let totalRealized = 0;
  let totalUnrealized = 0;
  let totalFees = 0;
  const perWhale: WhaleSummary[] = [];
  for (const [whaleAddress, e] of byWhale) {
    let unrealized = 0;
    const openCoins: CoinValue[] = [];
    for (const [coin, pos] of e.positions) {
      if (pos.netSz === 0) continue;
      openCoins.push(coin);
      const m = markPrice(coin);
      if (m === null) continue;
      const mark = Number(m);
      if (!Number.isFinite(mark)) continue;
      unrealized += unrealizedFor(pos, mark);
    }
    perWhale.push({
      whaleAddress,
      whaleAlias: e.whaleAlias,
      realizedUsd: e.realized,
      unrealizedUsd: unrealized,
      feesUsd: e.fees,
      openCoins,
    });
    totalRealized += e.realized;
    totalUnrealized += unrealized;
    totalFees += e.fees;
  }

  return {
    perWhale,
    totalRealizedUsd: totalRealized,
    totalUnrealizedUsd: totalUnrealized,
    totalFeesUsd: totalFees,
  };
}

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  const abs = Math.abs(n);
  const fixed = abs >= 1 ? abs.toFixed(2) : abs.toFixed(4);
  return `${n < 0 ? '-' : ''}$${fixed}`;
}

function fmtSignedUsd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  if (n === 0) return '$0.00';
  return `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function pnlEmoji(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '·';
  return n > 0 ? '🟢' : '🔴';
}

export interface PnlRenderPrefs {
  /** Cap on the per-whale list to keep messages readable. Default 10. */
  readonly maxWhales?: number;
}

export function renderPnl(summary: PnlSummary, prefs: PnlRenderPrefs = {}): Reply {
  const maxWhales = prefs.maxWhales ?? 10;
  if (summary.perWhale.length === 0) {
    return { text: 'No mirrored fills yet. Use /follow to start mirroring a whale.' };
  }

  const sorted = [...summary.perWhale].sort(
    (a, b) => b.realizedUsd + b.unrealizedUsd - (a.realizedUsd + a.unrealizedUsd),
  );
  const shown = sorted.slice(0, maxWhales);
  const hiddenCount = sorted.length - shown.length;

  const lines: string[] = ['PnL summary'];
  for (const w of shown) {
    const label = w.whaleAlias ?? fmtAddr(w.whaleAddress);
    const total = w.realizedUsd + w.unrealizedUsd;
    lines.push(`${pnlEmoji(total)} ${label}: ${fmtSignedUsd(total)}`);
    lines.push(
      `  realized ${fmtSignedUsd(w.realizedUsd)} · unrealized ${fmtSignedUsd(w.unrealizedUsd)} · fees ${fmtUsd(w.feesUsd)}`,
    );
    if (w.openCoins.length > 0) {
      lines.push(`  open: ${w.openCoins.join(', ')}`);
    }
  }
  if (hiddenCount > 0) {
    lines.push(`…and ${String(hiddenCount)} more`);
  }
  const grand = summary.totalRealizedUsd + summary.totalUnrealizedUsd;
  lines.push('—');
  lines.push(
    `Total: ${pnlEmoji(grand)} ${fmtSignedUsd(grand)}  (fees ${fmtUsd(summary.totalFeesUsd)})`,
  );
  return { text: lines.join('\n') };
}
