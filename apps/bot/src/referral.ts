/**
 * Pure referral attribution + leaderboard logic.
 *
 * Telegram deep-links carry `?start=<payload>`. We use the convention
 * `ref_<code>` where `<code>` is the referrer's invite code (a short
 * URL-safe slug we mint per user). Attribution is:
 *
 *   1. Onboarding receives `startParam` from /start.
 *   2. `parseReferralStartParam` extracts a normalized code, ignoring
 *      anything that doesn't match the spec (defensive — start params are
 *      attacker-controlled by anyone with a link).
 *   3. `attributeReferral` resolves the code to a referrer user (via
 *      injected lookup) and decides whether attribution applies:
 *        - self-referrals are rejected (no farming)
 *        - if the new user already has an attributed referrer, keep it
 *          (first attribution wins — protects against link-swap fraud)
 *        - if the new user signed up before the link was issued (clock
 *          skew or replay), we still accept; the rule is about the
 *          attribution slot being empty, not timing.
 *
 * The leaderboard ranks users by realized PnL over a window, with a
 * stable tie-break on userId so the output is deterministic for tests.
 */
import type { Reply } from './handlers.js';

const REF_PREFIX = 'ref_';
const REF_CODE_RE = /^[a-zA-Z0-9_-]{3,32}$/u;

export interface ParsedReferral {
  readonly code: string;
}

/**
 * Returns the normalized referral code from a /start deep-link payload, or
 * null if the payload is absent, malformed, or doesn't carry a referral.
 * Codes are stored case-insensitively (lowercased) so /start ref_Alice and
 * /start ref_alice attribute to the same person.
 */
export function parseReferralStartParam(
  startParam: string | null | undefined,
): ParsedReferral | null {
  if (startParam === null || startParam === undefined) return null;
  const trimmed = startParam.trim();
  if (!trimmed.startsWith(REF_PREFIX)) return null;
  const raw = trimmed.slice(REF_PREFIX.length);
  if (!REF_CODE_RE.test(raw)) return null;
  return { code: raw.toLowerCase() };
}

export interface ReferrerRecord {
  readonly userId: string;
  readonly code: string;
}

export type ReferrerLookupFn = (code: string) => Promise<ReferrerRecord | null>;

export interface AttributeReferralInput {
  /** UserId of the new user we're onboarding. */
  readonly newUserId: string;
  /** Existing attributed referrer userId, if any. */
  readonly existingReferrerUserId: string | null;
  /** Raw /start payload from Telegram. */
  readonly startParam: string | null;
}

export type AttributionOutcome =
  | { readonly kind: 'attributed'; readonly referrerUserId: string }
  | { readonly kind: 'no_payload' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unknown_code' }
  | { readonly kind: 'self_referral' }
  | { readonly kind: 'already_attributed'; readonly referrerUserId: string };

export async function attributeReferral(
  input: AttributeReferralInput,
  lookup: ReferrerLookupFn,
): Promise<AttributionOutcome> {
  if (input.existingReferrerUserId !== null) {
    // First attribution wins; do not even resolve the code.
    return { kind: 'already_attributed', referrerUserId: input.existingReferrerUserId };
  }
  if (input.startParam === null) return { kind: 'no_payload' };
  const parsed = parseReferralStartParam(input.startParam);
  if (parsed === null) {
    // Either the payload was something other than a referral (e.g. a /start
    // marker we don't yet understand) or it was malformed.
    if (!input.startParam.startsWith(REF_PREFIX)) return { kind: 'no_payload' };
    return { kind: 'malformed' };
  }
  const referrer = await lookup(parsed.code);
  if (referrer === null) return { kind: 'unknown_code' };
  if (referrer.userId === input.newUserId) return { kind: 'self_referral' };
  return { kind: 'attributed', referrerUserId: referrer.userId };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  readonly userId: string;
  /** Display handle (e.g. truncated tg @username or shortened address). */
  readonly handle: string;
  readonly realizedPnlUsd: number;
}

export interface LeaderboardResult {
  readonly entries: readonly LeaderboardEntry[];
  /** Total entries before truncation, for "and N more" tail rendering. */
  readonly totalRanked: number;
}

export interface ComputeLeaderboardOptions {
  /** Top N to keep. Default 10. */
  readonly topN?: number;
  /**
   * If true, drop entries with realizedPnl ≤ 0 from the leaderboard.
   * Default false — the leaderboard always shows the top N by absolute rank
   * so users see a representative sample even on a red day.
   */
  readonly losersHidden?: boolean;
}

export function computeLeaderboard(
  entries: readonly LeaderboardEntry[],
  options: ComputeLeaderboardOptions = {},
): LeaderboardResult {
  const topN = options.topN ?? 10;
  const filtered =
    options.losersHidden === true ? entries.filter((e) => e.realizedPnlUsd > 0) : entries.slice();
  // Sort: PnL desc, then userId asc for stable tie-break.
  filtered.sort((a, b) => {
    if (b.realizedPnlUsd !== a.realizedPnlUsd) return b.realizedPnlUsd - a.realizedPnlUsd;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return {
    entries: filtered.slice(0, topN),
    totalRanked: filtered.length,
  };
}

function fmtSignedUsd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  if (n === 0) return '$0.00';
  return `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

export interface RenderLeaderboardOptions {
  /** Header line, defaults to "Top traders". */
  readonly title?: string;
  /** UserId to highlight as "(you)" if present in the visible slice. */
  readonly viewerUserId?: string;
}

export function renderLeaderboard(
  result: LeaderboardResult,
  options: RenderLeaderboardOptions = {},
): Reply {
  if (result.entries.length === 0) {
    return { text: 'No ranked traders yet.' };
  }
  const title = options.title ?? '🏆 Top traders';
  const lines: string[] = [title, ''];
  for (const [i, e] of result.entries.entries()) {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${String(rank)}.`;
    const youTag = options.viewerUserId === e.userId ? '  ← you' : '';
    lines.push(`${medal} ${e.handle}`);
    lines.push(`    ${fmtSignedUsd(e.realizedPnlUsd)}${youTag}`);
    lines.push('');
  }
  const hidden = result.totalRanked - result.entries.length;
  if (hidden > 0) lines.push(`…and ${String(hidden)} more`);
  // Disclose the drift: numbers are summed from our local fill ledger
  // (intent.limitPx), not from HL's actual closedPnl. Until real fill
  // reconciliation lands, anyone comparing this to HL will see deltas.
  lines.push('');
  lines.push('ℹ️ Estimates from WhalePod\u2019s local fill log.');
  lines.push('   Source of truth is your Hyperliquid account.');
  return { text: lines.join('\n').trimEnd() };
}
