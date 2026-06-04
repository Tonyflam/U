/**
 * Fill reconciler.
 *
 * After `submitMirror` records a fill row, the `px`, `builder_fee_usd`,
 * and `realized_pnl_usd` columns hold our locally-estimated values:
 *   - `px` is the IOC LIMIT we sent, not the price HL actually filled at.
 *   - `builder_fee_usd` is derived from notional × requested rate, not
 *     the exact fee HL settled (rounding + tier shifts can diverge).
 *   - `realized_pnl_usd` is left NULL on opening fills and only set by
 *     `RealizedPnlFillSink` on closing legs via local position tracking,
 *     which drifts if mirrors get suppressed or HL rejects an order.
 *
 * This reconciler periodically pulls the truth from HL `userFills` for
 * every user with unreconciled mirror fills and overwrites the three
 * columns with the exact post-fill values, then stamps `reconciled_at`.
 *
 * Match is on `cloid` (we always send one; HL echoes it back on every
 * fill record). Multiple fill events per cloid (HL can split an IOC into
 * several partials) are summed: weighted-average px, summed sz, summed
 * fee, summed closedPnl.
 *
 * Failure policy: log + continue. A single user with a transient HL
 * outage must not block reconciliation for everyone else. Rows stay
 * unreconciled and we retry next tick.
 *
 * Lookback bounds the per-tick work to fills younger than `lookbackHours`
 * (default 24h). After that window we give up — HL's userFills snapshot
 * caps at ~2000 rows and we don't want to chase ancient orphans forever.
 */
import { and, eq, isNull, gte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { schema, type AnyDb } from '@whalepod/schema';
import type { HttpHlTransport } from '@whalepod/sdk';

export interface FillReconcilerDeps {
  readonly db: AnyDb;
  readonly transport: Pick<HttpHlTransport, 'info'>;
  readonly log: Logger;
  /** Tick interval. Default 60s. */
  readonly intervalMs?: number;
  /** How far back to scan for unreconciled fills. Default 24h. */
  readonly lookbackHours?: number;
}

interface RawUserFill {
  readonly cloid?: string;
  readonly px?: string | number;
  readonly sz?: string | number;
  readonly fee?: string | number;
  readonly closedPnl?: string | number;
  readonly side?: string;
}

interface PendingRow {
  readonly hlFillId: string;
  readonly userId: string;
  readonly mainWallet: string;
}

export class FillReconciler {
  private readonly intervalMs: number;
  private readonly lookbackHours: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: FillReconcilerDeps) {
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.lookbackHours = deps.lookbackHours ?? 24;
  }

  start(): void {
    if (this.timer) return;
    // Fire once on start so the first reconciliation runs without waiting
    // a full interval. Promise is intentionally not awaited.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return; // skip if previous tick still in-flight
    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (err) {
      this.deps.log.warn({ err }, 'fill-reconciler.tick.failed');
    } finally {
      this.running = false;
    }
  }

  async reconcileOnce(): Promise<{ readonly users: number; readonly reconciled: number }> {
    const cutoff = new Date(Date.now() - this.lookbackHours * 60 * 60 * 1000);
    const rows = await this.deps.db
      .select({
        hlFillId: schema.fills.hlFillId,
        userId: schema.fills.userId,
        mainWallet: schema.users.mainWallet,
      })
      .from(schema.fills)
      .innerJoin(schema.users, eq(schema.users.id, schema.fills.userId))
      .where(
        and(
          eq(schema.fills.isMirror, true),
          isNull(schema.fills.reconciledAt),
          gte(schema.fills.ts, cutoff),
        ),
      );

    const byUser = new Map<string, PendingRow[]>();
    for (const r of rows) {
      if (!r.userId) continue;
      const list = byUser.get(r.userId) ?? [];
      list.push({ hlFillId: r.hlFillId, userId: r.userId, mainWallet: r.mainWallet });
      byUser.set(r.userId, list);
    }

    let reconciled = 0;
    for (const [userId, pending] of byUser) {
      try {
        const n = await this.reconcileUser(userId, pending);
        reconciled += n;
      } catch (err) {
        this.deps.log.warn({ err, userId }, 'fill-reconciler.user.failed');
      }
    }
    return { users: byUser.size, reconciled };
  }

  private async reconcileUser(userId: string, pending: PendingRow[]): Promise<number> {
    const wallet = pending[0]?.mainWallet;
    if (!wallet) return 0;

    const hlFills = await this.deps.transport.info<readonly RawUserFill[]>({
      type: 'userFills',
      user: wallet,
    });

    // Aggregate HL fills per cloid: HL may split one IOC into multiple legs.
    interface Agg {
      pxNum: number;
      szNum: number;
      fee: number;
      closedPnl: number;
    }
    const byCloid = new Map<string, Agg>();
    for (const f of hlFills) {
      const cloid = (f.cloid ?? '').toLowerCase();
      if (!cloid) continue;
      const sz = numOr0(f.sz);
      const px = numOr0(f.px);
      if (sz === 0) continue;
      const agg = byCloid.get(cloid) ?? { pxNum: 0, szNum: 0, fee: 0, closedPnl: 0 };
      agg.pxNum += px * sz;
      agg.szNum += sz;
      agg.fee += numOr0(f.fee);
      agg.closedPnl += numOr0(f.closedPnl);
      byCloid.set(cloid, agg);
    }

    let count = 0;
    for (const row of pending) {
      const agg = byCloid.get(row.hlFillId.toLowerCase());
      if (!agg || agg.szNum === 0) continue;
      const vwap = agg.pxNum / agg.szNum;
      await this.deps.db
        .update(schema.fills)
        .set({
          px: vwap.toFixed(8),
          sz: agg.szNum.toFixed(8),
          notionalUsd: (vwap * agg.szNum).toFixed(2),
          builderFeeUsd: agg.fee.toFixed(6),
          realizedPnlUsd: agg.closedPnl.toFixed(6),
          reconciledAt: sql`NOW()`,
        })
        .where(eq(schema.fills.hlFillId, row.hlFillId));
      count++;
    }
    if (count > 0) {
      this.deps.log.info(
        { userId, reconciled: count, pending: pending.length },
        'fill-reconciler.user.ok',
      );
    }
    return count;
  }
}

function numOr0(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
