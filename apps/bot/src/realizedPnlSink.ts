/**
 * Decorating FillSink that tracks per-(user, coin) net position in memory
 * and stamps `realized_pnl_usd` on closing legs before delegating to an
 * inner sink (typically `DrizzleFillSink`).
 *
 * Convention: net size is signed (long > 0, short < 0). A fill in the
 * opposite direction of the open position realizes P&L on the closed
 * portion at the difference between fill px and weighted-avg entry px.
 * A fill that flips the position closes the entire existing leg and
 * opens a new leg at the fill px for the residual size.
 *
 * State is in-memory and best-effort. On restart, in-flight positions
 * are forgotten and the next fill on that (user, coin) is treated as a
 * fresh opening leg. This matches the rest of the data path: the HL
 * ack and the audit row are the durable records; reporting columns
 * degrade gracefully.
 */
import type { FillSink, MirrorFillRow } from './fillSink.js';

interface Position {
  /** Signed net size: long positive, short negative. */
  netSz: number;
  /** Weighted-average entry price of the current open leg. */
  avgPx: number;
}

export interface RealizedPnlFillSinkOptions {
  readonly inner: FillSink;
}

export class RealizedPnlFillSink implements FillSink {
  private readonly inner: FillSink;
  private readonly positions = new Map<string, Position>();

  constructor(opts: RealizedPnlFillSinkOptions) {
    this.inner = opts.inner;
  }

  async recordMirrorFill(row: MirrorFillRow): Promise<void> {
    const key = `${row.userId}|${row.coin}`;
    const px = Number(row.px);
    const sz = Number(row.sz);
    const delta = row.side === 'B' ? sz : -sz;

    const prev = this.positions.get(key) ?? { netSz: 0, avgPx: 0 };
    const { next, realized } = applyFill(prev, delta, px);
    this.positions.set(key, next);

    const enriched: MirrorFillRow =
      realized !== 0 ? { ...row, realizedPnlUsd: realized.toFixed(6) } : row;
    await this.inner.recordMirrorFill(enriched);
  }
}

interface ApplyResult {
  next: Position;
  realized: number;
}

/** Pure step: apply a signed fill to a position, returning new state and realized P&L. */
export function applyFill(prev: Position, delta: number, px: number): ApplyResult {
  if (prev.netSz === 0) {
    return { next: { netSz: delta, avgPx: px }, realized: 0 };
  }
  const sameSide = (prev.netSz > 0 && delta > 0) || (prev.netSz < 0 && delta < 0);
  if (sameSide) {
    const newSz = prev.netSz + delta;
    const newAvg = (prev.avgPx * Math.abs(prev.netSz) + px * Math.abs(delta)) / Math.abs(newSz);
    return { next: { netSz: newSz, avgPx: newAvg }, realized: 0 };
  }
  // Opposite side: close up to |prev.netSz|, possibly flip.
  const closedSz = Math.min(Math.abs(delta), Math.abs(prev.netSz));
  // Long: profit when px > avgPx. Short: profit when avgPx > px.
  const realized = prev.netSz > 0 ? (px - prev.avgPx) * closedSz : (prev.avgPx - px) * closedSz;
  const newSz = prev.netSz + delta;
  if (newSz === 0) {
    return { next: { netSz: 0, avgPx: 0 }, realized };
  }
  if (Math.sign(newSz) === Math.sign(prev.netSz)) {
    // Partial close; avg stays.
    return { next: { netSz: newSz, avgPx: prev.avgPx }, realized };
  }
  // Flip: residual opens new leg at fill px.
  return { next: { netSz: newSz, avgPx: px }, realized };
}
