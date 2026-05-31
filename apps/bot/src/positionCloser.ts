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
import type { MarkPriceFn } from './pnl.js';
import type { AgentSigner, AuditSink } from './submitMirror.js';
import type { LivePositionsLookup } from './hlLivePositions.js';

export interface CloseUser {
  readonly id: string;
  readonly mainWallet: Address;
  readonly agentAddress: Address;
  readonly currentFeeTenthsBp: number;
  readonly approvedMaxFeeTenthsBp: number;
}

export type CloseCoinResult =
  | { readonly coin: string; readonly kind: 'submitted'; readonly sz: string; readonly isBuy: boolean }
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
      results.push({ coin: pos.coin, kind: 'submitted', sz, isBuy });
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
  const seed = `close:${userId}:${coin}:${nonce}`;
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
