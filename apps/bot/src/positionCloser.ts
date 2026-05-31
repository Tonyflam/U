/**
 * Closes one or all live HL perp positions for a user, using a reduce-only
 * IOC order against the current mark price. Designed for the /close and
 * /closeall TG commands.
 *
 * Source of truth is HL `clearinghouseState`, not the bot's reconstructed
 * fill ledger — so a closure works even if a whale's exit fill never
 * reached the mirror.
 *
 * Each order:
 *   - side = opposite of current szi (long → sell, short → buy)
 *   - reduceOnly = true (HL will reject if it would open a new position)
 *   - tif = 'Ioc' (immediate-or-cancel; behaves like market)
 *   - limitPx = mark ± 1% slippage cap on the closing side
 *   - cloid = deterministic from (userId, coin, nonce) so a retry of the
 *     same /close inside ~1s coalesces at HL instead of double-closing.
 */
import type { Address } from '@whalepod/schema';
import {
  buildOrderAction,
  HlExchangeError,
  HlTransportError,
  type HttpHlTransport,
  type OrderIntent,
} from '@whalepod/sdk';
import type { AssetIndexResolver } from './mirrorEngine.js';
import type { MarkPriceFn, PnlFill } from './pnl.js';
import type { AgentSigner, AuditSink } from './submitMirror.js';
import type { LivePositionsLookup } from './hlLivePositions.js';
import type { FillSink } from './fillSink.js';

export interface PnlFillReader {
  listFillsForUser(userId: string, limit: number): Promise<readonly PnlFill[]>;
}

export interface CloseUser {
  readonly id: string;
  readonly mainWallet: Address;
  readonly agentAddress: Address;
  readonly currentFeeTenthsBp: number;
  readonly approvedMaxFeeTenthsBp: number;
}

/**
 * When a coin is closed and we have local ledger data for it, we also
 * surface the per-coin trade summary so the bot can mint a "share this
 * trade" card. Absent when no mirrored fills exist for the coin (e.g.
 * the user opened the position outside WhalePod).
 */
export interface CloseTradeSummary {
  /** 'long' if the pre-close exposure was net positive; 'short' otherwise. */
  readonly side: 'long' | 'short';
  /** Absolute size that was closed, decimal string. */
  readonly sz: string;
  /** Volume-weighted average entry price, decimal string. */
  readonly entryPx: string;
  /** Mark price used as the close fill, decimal string. */
  readonly exitPx: string;
  /** Realized USD PnL across all whales for this coin, decimal string (signed). */
  readonly pnlUsd: string;
  /** Percent PnL vs cost basis, decimal string (signed, e.g. "8.12"). */
  readonly pnlPct: string;
  /** Alias of the whale that contributed the largest |netSz|, if any. */
  readonly whaleAlias: string | null;
}

export type CloseCoinResult =
  | {
      readonly coin: string;
      readonly kind: 'submitted';
      readonly sz: string;
      readonly isBuy: boolean;
      /** Present when we have local fills for this coin to summarize. */
      readonly trade?: CloseTradeSummary;
    }
  | { readonly coin: string; readonly kind: 'no_mark' }
  | { readonly coin: string; readonly kind: 'exchange_error'; readonly message: string }
  | { readonly coin: string; readonly kind: 'transport_error'; readonly message: string }
  | { readonly coin: string; readonly kind: 'asset_unknown' };

export type CloseOutcome =
  | { readonly kind: 'no_positions' }
  | { readonly kind: 'coin_not_open'; readonly coin: string }
  | { readonly kind: 'closed'; readonly results: readonly CloseCoinResult[] };

export interface PositionCloserDeps {
  readonly positions: LivePositionsLookup;
  readonly assets: AssetIndexResolver;
  readonly markPrice: MarkPriceFn;
  readonly signer: AgentSigner;
  readonly transport: Pick<HttpHlTransport, 'exchange'>;
  readonly audit: AuditSink;
  readonly builderAddress: Address;
  readonly nonce: () => number;
  readonly now: () => number;
  /**
   * Optional pair used to also reconcile the bot's local PnL ledger after
   * the HL ack. We compute per-whale netSz on the closed coin from
   * `pnlReader` and write canceling synthetic fills to `fillSink` so /pnl
   * stops showing "still holding" for what is no longer on HL.
   */
  readonly pnlReader?: PnlFillReader;
  readonly fillSink?: FillSink;
  /** Max acceptable slippage on the close, in basis points. Default 100 (1%). */
  readonly slippageBps?: number;
}

const PX_PRECISION = 5;
const SZ_DECIMALS = 4;
const DEFAULT_SLIPPAGE_BPS = 100;

export async function closePositions(
  user: CloseUser,
  coinFilter: string | null,
  deps: PositionCloserDeps,
): Promise<CloseOutcome> {
  const live = await deps.positions.forUser(user.mainWallet);
  if (live.length === 0) return { kind: 'no_positions' };

  const wanted = coinFilter ? coinFilter.toUpperCase() : null;
  const targets = wanted ? live.filter((p) => p.coin === wanted) : live;
  if (wanted && targets.length === 0) return { kind: 'coin_not_open', coin: wanted };

  const slippageBps = deps.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  // Pre-load the user's local fill history once so we can reconcile the
  // PnL ledger per closed coin without re-querying inside the loop.
  const ledgerFills =
    deps.pnlReader && deps.fillSink
      ? await deps.pnlReader.listFillsForUser(user.id, 500).catch(() => [] as readonly PnlFill[])
      : ([] as readonly PnlFill[]);
  const results: CloseCoinResult[] = [];
  for (const pos of targets) {
    const asset = deps.assets.resolve(pos.coin);
    if (asset === undefined) {
      results.push({ coin: pos.coin, kind: 'asset_unknown' });
      continue;
    }
    const markRaw = deps.markPrice(pos.coin);
    if (markRaw === null) {
      results.push({ coin: pos.coin, kind: 'no_mark' });
      continue;
    }
    const mark = Number(markRaw);
    if (!Number.isFinite(mark) || mark <= 0) {
      results.push({ coin: pos.coin, kind: 'no_mark' });
      continue;
    }

    const isBuy = pos.szi < 0; // shorts close with a buy; longs close with a sell
    const slip = mark * (slippageBps / 10_000);
    const limitPx = isBuy ? mark + slip : mark - slip;
    const sz = formatSz(Math.abs(pos.szi));
    if (sz === '0') continue;

    const nonce = deps.nonce();
    const cloid = cloidFor(user.id, pos.coin, nonce);
    const orderIntent: OrderIntent = {
      asset,
      isBuy,
      limitPx: formatPx(limitPx),
      sz,
      reduceOnly: true,
      tif: 'Ioc',
      cloid,
    };
    const action = buildOrderAction({
      intent: orderIntent,
      builderAddress: deps.builderAddress,
      requestedFeeTenthsBp: user.currentFeeTenthsBp,
      userApprovedMaxFeeTenthsBp: user.approvedMaxFeeTenthsBp,
    });

    try {
      const signature = await deps.signer.sign({
        userId: user.id,
        agentAddress: user.agentAddress,
        action,
        nonce,
      });
      await deps.transport.exchange({ action, signature, nonce });
      await deps.audit.appendAudit({
        actor: `op:${user.id}`,
        action: 'position.close',
        target: `coin:${pos.coin}`,
        after: { outcome: 'submitted', sz, isBuy, limitPx: orderIntent.limitPx, nonce, cloid },
      });
      let trade: CloseTradeSummary | undefined;
      if (deps.fillSink) {
        trade = await reconcileLedger({
          fills: ledgerFills,
          coin: pos.coin,
          mark,
          userId: user.id,
          cloid,
          now: deps.now(),
          sink: deps.fillSink,
        });
      }
      results.push(
        trade
          ? { coin: pos.coin, kind: 'submitted', sz, isBuy, trade }
          : { coin: pos.coin, kind: 'submitted', sz, isBuy },
      );
    } catch (err) {
      const message = errMessage(err);
      const kind = err instanceof HlExchangeError ? 'exchange_error' : 'transport_error';
      await deps.audit.appendAudit({
        actor: `op:${user.id}`,
        action: 'position.close',
        target: `coin:${pos.coin}`,
        after: { outcome: kind, message, nonce, cloid },
      });
      results.push({ coin: pos.coin, kind, message });
    }
  }
  return { kind: 'closed', results };
}

function errMessage(err: unknown): string {
  if (err instanceof HlExchangeError) return err.body.response;
  if (err instanceof HlTransportError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function formatPx(n: number): string {
  return Number.parseFloat(n.toPrecision(PX_PRECISION)).toString();
}

function formatSz(n: number): string {
  const fixed = n.toFixed(SZ_DECIMALS);
  return Number.parseFloat(fixed).toString();
}

function cloidFor(userId: string, coin: string, nonce: number): `0x${string}` {
  const seed = `close:${userId}:${coin}:${String(nonce)}`;
  const lo = fnv1a64(seed, 0n);
  const hi = fnv1a64(seed, 0xcbf29ce484222325n);
  const hex = hi.toString(16).padStart(16, '0') + lo.toString(16).padStart(16, '0');
  return `0x${hex}`;
}

function fnv1a64(s: string, seed: bigint): bigint {
  const FNV_PRIME = 1099511628211n;
  const MASK = 0xffffffffffffffffn;
  let h = (0xcbf29ce484222325n ^ seed) & MASK;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & MASK;
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

/**
 * Mirrors the closure into the bot's local fill ledger so /pnl stops
 * reporting "still holding" for a coin we just closed on HL. Walks the
 * user's existing mirror fills, sums per-whale netSz / costBasis for the
 * closed coin, and writes one synthetic canceling fill per whale that
 * still has nonzero exposure. realizedPnlUsd is set to the existing
 * mark-to-market PnL so the "Closed trades" total updates correctly.
 *
 * builderFeeUsd is left at 0 here — the real builder fee is recorded by
 * HL on the actual reduce-only IOC order; if we ever start ingesting our
 * own fills from HL, we should de-dupe these synthetic rows by hlFillId
 * prefix `close:`.
 */
async function reconcileLedger(input: {
  readonly fills: readonly PnlFill[];
  readonly coin: string;
  readonly mark: number;
  readonly userId: string;
  readonly cloid: string;
  readonly now: number;
  readonly sink: FillSink;
}): Promise<CloseTradeSummary | undefined> {
  interface Agg {
    netSz: number;
    costBasisUsd: number;
    whaleAlias: string | null;
  }
  const byWhale = new Map<string, Agg>();
  for (const f of input.fills) {
    if (f.coin !== input.coin) continue;
    const sz = Number(f.sz);
    const px = Number(f.px);
    if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
    const signed = f.side === 'B' ? sz : -sz;
    const a = byWhale.get(f.whaleAddress) ?? {
      netSz: 0,
      costBasisUsd: 0,
      whaleAlias: f.whaleAlias ?? null,
    };
    a.netSz += signed;
    a.costBasisUsd += signed * px;
    byWhale.set(f.whaleAddress, a);
  }

  let totalNetSz = 0;
  let totalCost = 0;
  let totalRealized = 0;
  let topWhaleAbsSz = 0;
  let topWhaleAlias: string | null = null;
  for (const [whaleAddress, pos] of byWhale) {
    if (Math.abs(pos.netSz) < 1e-8) continue;
    const isBuyToClose = pos.netSz < 0;
    const sz = Math.abs(pos.netSz);
    const realizedPnlUsd = pos.netSz * input.mark - pos.costBasisUsd;
    totalNetSz += pos.netSz;
    totalCost += pos.costBasisUsd;
    totalRealized += realizedPnlUsd;
    if (sz > topWhaleAbsSz) {
      topWhaleAbsSz = sz;
      topWhaleAlias = pos.whaleAlias;
    }
    await input.sink.recordMirrorFill({
      hlFillId: `close:${input.cloid}:${whaleAddress}`,
      whaleAddress,
      coin: input.coin,
      side: isBuyToClose ? 'B' : 'S',
      px: formatPx(input.mark),
      sz: formatSz(sz),
      notionalUsd: (sz * input.mark).toFixed(2),
      builderFeeTenthsBp: 0,
      builderFeeUsd: '0',
      userId: input.userId,
      ts: input.now,
      realizedPnlUsd: realizedPnlUsd.toFixed(6),
    });
  }

  if (Math.abs(totalNetSz) < 1e-8) return undefined;
  const sz = Math.abs(totalNetSz);
  const entryPx = Math.abs(totalCost / totalNetSz);
  const costAbs = Math.abs(totalCost);
  const pct = costAbs > 0 ? (totalRealized / costAbs) * 100 : 0;
  return {
    side: totalNetSz > 0 ? 'long' : 'short',
    sz: formatSz(sz),
    entryPx: formatPx(entryPx),
    exitPx: formatPx(input.mark),
    pnlUsd: totalRealized.toFixed(2),
    pnlPct: pct.toFixed(2),
    whaleAlias: topWhaleAlias,
  };
}
