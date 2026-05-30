/**
 * Pure risk engine. Sits between `evaluateMirror`'s `submit` decision and the
 * actual exchange submission. Every check below is *additive* to the
 * mirror-engine gates and to on-chain / HL protocol limits — removing any
 * one layer MUST NOT allow a non-compliant order through.
 *
 * Responsibilities:
 *
 *   1. Equity floor       — never trade if user's HL account equity is at
 *                           or below the user-set floor.
 *   2. Slippage cap       — refuse if mirror px deviates from the reference
 *                           (whale's fill px or mid) beyond `maxSlippageBps`.
 *   3. Daily notional cap — refuse if 24h cumulative mirror notional would
 *                           exceed the per-user cap.
 *   4. Geo block          — refuse if user's resolved country is in the
 *                           blocklist (set by ops). If `requireKnownGeo`,
 *                           also refuse when country is unknown.
 *
 * Pure: NO i/o here. All reads (equity, daily-used, country) come from
 * injected providers. Audit + Redis increment of daily-used live in the
 * caller (a side-effect orchestrator), so this function is replayable in
 * tests against fixtures.
 */

export interface AccountEquity {
  readonly equityUsd: number;
  readonly withdrawableUsd: number;
}

export interface RiskProviders {
  /** Returns current HL account equity for the user. */
  accountEquity: {
    forUser(userId: string): Promise<AccountEquity | undefined>;
  };
  /** Returns the cumulative mirror notional (USD) used by `userId` since
   *  `sinceMs` (typically now - 24h). */
  dailyNotional: {
    usedUsd(userId: string, sinceMs: number): Promise<number>;
  };
  /** Country resolution. Source is usually a CF `cf.country` header captured
   *  at the API edge and persisted on the user row. */
  geo: {
    countryFor(userId: string): Promise<string | undefined>;
  };
}

export interface RiskPolicy {
  /** Max allowed deviation between mirror px and reference px (bps). */
  readonly maxSlippageBps: number;
  /** Max cumulative mirror notional per rolling 24h window, USD. */
  readonly maxDailyNotionalUsd: number;
  /** ISO 3166-1 alpha-2 country codes that are NOT allowed to trade. */
  readonly blockedCountries: readonly string[];
  /** If true, an unknown country is treated as blocked. */
  readonly requireKnownGeo: boolean;
}

export interface RiskInput {
  readonly userId: string;
  readonly equityFloorUsd: string;
  readonly mirrorSizeUsd: number;
  /** Mirror order price (decimal). */
  readonly px: number;
  /** Reference price (e.g. whale fill px or HL mid). Same coin. */
  readonly refPx: number;
  /** Wall-clock now (ms). Injected so tests are deterministic. */
  readonly now: number;
}

export interface RiskDeps extends RiskProviders {
  readonly policy: RiskPolicy;
}

export type RiskBlockReason =
  | 'equity_unknown'
  | 'equity_floor_breach'
  | 'slippage_exceeded'
  | 'daily_notional_exceeded'
  | 'geo_blocked'
  | 'geo_unknown';

export type RiskDecision =
  | { readonly kind: 'allow'; readonly equity: AccountEquity; readonly dailyUsedUsd: number }
  | {
      readonly kind: 'block';
      readonly reason: RiskBlockReason;
      readonly detail?: string;
    };

const DAY_MS = 24 * 60 * 60 * 1000;
const BPS_DENOM = 10_000;

/**
 * Returns a slippage in bps between `px` and `refPx`. Symmetric: always
 * non-negative. If refPx is non-positive, slippage is treated as infinite.
 */
export function slippageBps(px: number, refPx: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(refPx) || refPx <= 0) return Infinity;
  return (Math.abs(px - refPx) / refPx) * BPS_DENOM;
}

export async function evaluateRisk(input: RiskInput, deps: RiskDeps): Promise<RiskDecision> {
  // 1. Geo first — cheap check, reject before any provider lookups that
  //    might leak metadata about a blocked user.
  const country = await deps.geo.countryFor(input.userId);
  if (country === undefined) {
    if (deps.policy.requireKnownGeo) {
      return { kind: 'block', reason: 'geo_unknown' };
    }
  } else if (deps.policy.blockedCountries.includes(country.toUpperCase())) {
    return { kind: 'block', reason: 'geo_blocked', detail: country.toUpperCase() };
  }

  // 2. Slippage.
  const slip = slippageBps(input.px, input.refPx);
  if (slip > deps.policy.maxSlippageBps) {
    return {
      kind: 'block',
      reason: 'slippage_exceeded',
      detail: `${slip.toFixed(2)} bps > ${String(deps.policy.maxSlippageBps)} bps`,
    };
  }

  // 3. Equity.
  const equity = await deps.accountEquity.forUser(input.userId);
  if (equity === undefined) {
    return { kind: 'block', reason: 'equity_unknown' };
  }
  const floor = Number(input.equityFloorUsd);
  if (!Number.isFinite(floor) || floor < 0) {
    return { kind: 'block', reason: 'equity_unknown', detail: 'invalid floor' };
  }
  if (equity.equityUsd <= floor) {
    return {
      kind: 'block',
      reason: 'equity_floor_breach',
      detail: `${equity.equityUsd.toString()} <= ${input.equityFloorUsd}`,
    };
  }

  // 4. Daily notional. Rolling 24h.
  const used = await deps.dailyNotional.usedUsd(input.userId, input.now - DAY_MS);
  if (used + input.mirrorSizeUsd > deps.policy.maxDailyNotionalUsd) {
    return {
      kind: 'block',
      reason: 'daily_notional_exceeded',
      detail: `${(used + input.mirrorSizeUsd).toString()} > ${String(deps.policy.maxDailyNotionalUsd)}`,
    };
  }

  return { kind: 'allow', equity, dailyUsedUsd: used };
}
