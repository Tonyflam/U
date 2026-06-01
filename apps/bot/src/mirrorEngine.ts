/**
 * Pure mirror engine: turn a `MirrorIntent` into a `MirrorDecision`.
 *
 * This is the security-critical core of the Order Router. Every decision
 * branch is unit-tested. The function has NO side effects — DB reads,
 * signing, HTTP submission are all out-of-scope. Side-effect orchestration
 * lives in `submitMirror.ts`.
 *
 * Defense in depth: every skip reason below ALSO must be enforceable
 * elsewhere (DB CHECK constraints, HL protocol caps, on-chain approvals).
 * Removing any one of these layers MUST NOT allow a non-compliant order
 * to land on Hyperliquid.
 */
import {
  BUILDER_FEE_PERP_CAP_TENTHS_BP,
  buildOrderAction,
  clampFeeTenthsBp,
  type HlOrderAction,
  type OrderIntent,
} from '@whalepod/sdk';
import { MirrorIntent } from '@whalepod/ws-consumer';
import type { Address } from '@whalepod/schema';

/** User snapshot the engine needs. Loaded by `submitMirror` from the DB. */
export interface UserSnapshot {
  readonly id: string;
  readonly killSwitch: boolean;
  readonly revoked: boolean;
  readonly agentAddress: Address;
  readonly approvedMaxFeeTenthsBp: number;
  readonly currentFeeTenthsBp: number;
  readonly equityFloorUsd: string;
}

/** Subscription snapshot. */
export interface SubscriptionSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly whaleAddress: Address;
  readonly paused: boolean;
  readonly maxSizeUsd: string;
  readonly maxLeverage: number;
  readonly allowedCoins: readonly string[] | null;
}

/** Resolves a coin ticker to the HL perp asset index. */
export interface AssetIndexResolver {
  resolve(coin: string): number | undefined;
}

export interface MirrorEngineDeps {
  readonly users: { byId(id: string): Promise<UserSnapshot | undefined> };
  readonly subscriptions: {
    forUserAndWhale(
      userId: string,
      whaleAddress: string,
    ): Promise<SubscriptionSnapshot | undefined>;
  };
  readonly assets: AssetIndexResolver;
  readonly builderAddress: Address;
  /**
   * Optional per-(user, coin) mirror suppression. Set by /close so the
   * whale's eventual exit fill doesn't open an opposite-direction position
   * for a user who already manually closed.
   */
  readonly mirrorBlocks?: {
    isBlocked(userId: string, coin: string, side: 'B' | 'S'): Promise<boolean>;
  };
  /**
   * Floor for derived sz before we refuse the order. Default 0 — meaning we
   * refuse if rounding nukes the size. Per-asset min-size lives in transport.
   */
  readonly minSz?: number;
  /** Global kill switch (settable by admin). Default false. */
  readonly globalKill?: boolean;
}

export type SkipReason =
  | 'invalid_intent'
  | 'global_kill'
  | 'user_not_found'
  | 'user_killed'
  | 'user_revoked'
  | 'subscription_not_found'
  | 'subscription_paused'
  | 'whale_mismatch'
  | 'coin_not_allowed'
  | 'asset_unknown'
  | 'fee_exceeds_cap'
  | 'size_zero'
  | 'invalid_price'
  | 'user_closed_recently';

export type MirrorDecision =
  | { readonly kind: 'skip'; readonly reason: SkipReason; readonly detail?: string }
  | {
      readonly kind: 'submit';
      readonly user: UserSnapshot;
      readonly subscription: SubscriptionSnapshot;
      readonly action: HlOrderAction;
      readonly orderIntent: OrderIntent;
      readonly coin: string;
      readonly mirrorSizeUsd: number;
      readonly feeTenthsBp: number;
      readonly cloid: `0x${string}`;
    };

const PX_PRECISION = 5;
const SZ_DECIMALS = 4;

export async function evaluateMirror(
  raw: unknown,
  deps: MirrorEngineDeps,
): Promise<MirrorDecision> {
  const parsed = MirrorIntent.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'skip', reason: 'invalid_intent', detail: parsed.error.message };
  }
  const intent = parsed.data;

  if (deps.globalKill === true) return { kind: 'skip', reason: 'global_kill' };

  const user = await deps.users.byId(intent.subscriberId);
  if (user === undefined) return { kind: 'skip', reason: 'user_not_found' };
  if (user.killSwitch) return { kind: 'skip', reason: 'user_killed' };
  if (user.revoked) return { kind: 'skip', reason: 'user_revoked' };

  const sub = await deps.subscriptions.forUserAndWhale(user.id, intent.whaleAddress);
  if (sub === undefined) return { kind: 'skip', reason: 'subscription_not_found' };
  if (sub.paused) return { kind: 'skip', reason: 'subscription_paused' };
  if (sub.whaleAddress !== intent.whaleAddress) {
    return { kind: 'skip', reason: 'whale_mismatch' };
  }
  if (sub.allowedCoins !== null && !sub.allowedCoins.includes(intent.coin)) {
    return { kind: 'skip', reason: 'coin_not_allowed' };
  }

  const asset = deps.assets.resolve(intent.coin);
  if (asset === undefined) return { kind: 'skip', reason: 'asset_unknown' };

  if (deps.mirrorBlocks && (await deps.mirrorBlocks.isBlocked(user.id, intent.coin, intent.side))) {
    return { kind: 'skip', reason: 'user_closed_recently' };
  }

  const px = Number(intent.px);
  if (!Number.isFinite(px) || px <= 0) return { kind: 'skip', reason: 'invalid_price' };

  const maxSizeUsd = Number(sub.maxSizeUsd);
  if (!Number.isFinite(maxSizeUsd) || maxSizeUsd <= 0) {
    return { kind: 'skip', reason: 'size_zero' };
  }
  const mirrorSizeUsd = maxSizeUsd;
  const minSz = deps.minSz ?? 0;
  const szNum = mirrorSizeUsd / px;
  if (!Number.isFinite(szNum) || szNum <= minSz) {
    return { kind: 'skip', reason: 'size_zero' };
  }
  const sz = formatSz(szNum);
  if (sz === '0') return { kind: 'skip', reason: 'size_zero' };

  // Builder fee: defense in depth. The clamper ALSO enforces protocol cap,
  // but the explicit check below means we never even build an action that
  // would charge above-cap, even if `clampFeeTenthsBp` regresses.
  if (user.currentFeeTenthsBp > BUILDER_FEE_PERP_CAP_TENTHS_BP) {
    return { kind: 'skip', reason: 'fee_exceeds_cap' };
  }
  if (user.currentFeeTenthsBp > user.approvedMaxFeeTenthsBp) {
    return { kind: 'skip', reason: 'fee_exceeds_cap' };
  }
  const feeTenthsBp = clampFeeTenthsBp(user.currentFeeTenthsBp, user.approvedMaxFeeTenthsBp);

  const cloid = cloidFromKey(intent.idempotencyKey);
  // For market-style mirror: pass through whale's fill px as the limit;
  // tif=Ioc + reduceOnly=false. Slippage cap is enforced by the price
  // sanity check above + per-asset bands in transport (later unit).
  const orderIntent: OrderIntent = {
    asset,
    isBuy: intent.side === 'B',
    limitPx: formatPx(px),
    sz,
    reduceOnly: false,
    tif: 'Ioc',
    cloid,
  };

  const action = buildOrderAction({
    intent: orderIntent,
    builderAddress: deps.builderAddress,
    requestedFeeTenthsBp: feeTenthsBp,
    userApprovedMaxFeeTenthsBp: user.approvedMaxFeeTenthsBp,
  });

  return {
    kind: 'submit',
    user,
    subscription: sub,
    action,
    orderIntent,
    coin: intent.coin,
    mirrorSizeUsd,
    feeTenthsBp,
    cloid,
  };
}

function formatPx(n: number): string {
  return Number.parseFloat(n.toPrecision(PX_PRECISION)).toString();
}

function formatSz(n: number): string {
  const fixed = n.toFixed(SZ_DECIMALS);
  return Number.parseFloat(fixed).toString();
}

/**
 * Deterministic cloid (16-byte client order id) from the idempotency key.
 * HL accepts a 16-byte 0x… hex string. We use FNV-1a 64 twice (low/high halves)
 * to derive a stable id without a crypto dep. Collisions are statistically
 * irrelevant for the per-user, per-fill key space; HL itself dedupes cloids
 * per subaccount and will reject a true repeat.
 */
function cloidFromKey(key: string): `0x${string}` {
  const lo = fnv1a64(key, 0n);
  const hi = fnv1a64(key, 0xcbf29ce484222325n);
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
