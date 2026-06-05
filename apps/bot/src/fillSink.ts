/**
 * Mirror-fill writer: persists one row to the `fills` table after a
 * successful HL ack. This is the only producer of `is_mirror=true` rows
 * and is the upstream data source for /pnl, /leaderboard, and the
 * admin `fills24h` / `builderFeesUsd24h` stats.
 *
 * Failure policy mirrors `FillPublisher`: log and swallow. The audit row
 * and the HL ack are the durable records of what happened; a missing
 * fill row degrades reporting only and must never roll back the trade.
 *
 * `realized_pnl_usd` is left `NULL` here. A later layer that tracks
 * per-(user, coin) net position can wrap this sink and fill the column
 * on closing legs; the leaderboard's `COALESCE` already handles NULL.
 */
import type { Logger } from 'pino';
import { schema, type AnyDb } from '@whalepod/schema';

export interface MirrorFillRow {
  /** Idempotency key from `submitMirror.cloid` — also doubles as `hl_fill_id`. */
  readonly hlFillId: string;
  /** Whale wallet whose fill we mirrored. Stored in `fills.wallet` so the
   * existing /pnl reader can join `whales` on it for the alias. */
  readonly whaleAddress: string;
  readonly coin: string;
  readonly side: 'B' | 'S';
  /** Decimal strings to preserve precision. */
  readonly px: string;
  readonly sz: string;
  readonly notionalUsd: string;
  readonly builderFeeTenthsBp: number;
  readonly builderFeeUsd: string;
  readonly userId: string;
  /** Wall-clock ms. */
  readonly ts: number;
  /** Decimal string. Set by a wrapping P&L tracker on closing legs; NULL otherwise. */
  readonly realizedPnlUsd?: string;
}

export interface FillSink {
  recordMirrorFill(row: MirrorFillRow): Promise<void>;
}

export interface DrizzleFillSinkOptions {
  readonly db: AnyDb;
  readonly log: Logger;
}

export class DrizzleFillSink implements FillSink {
  private readonly db: AnyDb;
  private readonly log: Logger;

  constructor(opts: DrizzleFillSinkOptions) {
    this.db = opts.db;
    this.log = opts.log;
  }

  async recordMirrorFill(row: MirrorFillRow): Promise<void> {
    try {
      // Synthetic ledger rows from /close /closeall use a `close:` cloid that
      // will never appear in HL's userFills. Their px / sz / realizedPnl are
      // computed locally from mark and cost basis at write time — stamp them
      // reconciled now so the reconciler does not retry forever and the
      // leaderboard treats them as final.
      const isSyntheticClose = row.hlFillId.startsWith('close:');
      await this.db
        .insert(schema.fills)
        .values({
          hlFillId: row.hlFillId,
          wallet: row.whaleAddress,
          coin: row.coin,
          side: row.side,
          px: row.px,
          sz: row.sz,
          notionalUsd: row.notionalUsd,
          isMirror: true,
          userId: row.userId,
          builderFeeTenthsBp: row.builderFeeTenthsBp,
          builderFeeUsd: row.builderFeeUsd,
          ts: new Date(row.ts),
          ...(row.realizedPnlUsd !== undefined ? { realizedPnlUsd: row.realizedPnlUsd } : {}),
          ...(isSyntheticClose ? { reconciledAt: new Date(row.ts) } : {}),
        })
        .onConflictDoNothing({ target: schema.fills.hlFillId });
    } catch (err) {
      this.log.warn({ err, hlFillId: row.hlFillId }, 'fill-sink: insert failed');
    }
  }
}
