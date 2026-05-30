import type { HlFillEvent, MirrorIntent } from './types.js';

export interface Subscriber {
  /** users.id (UUID). */
  readonly id: string;
  /** Whale they are mirroring. */
  readonly whaleAddress: string;
  /** Subscription paused? Paused subs produce no intents. */
  readonly paused: boolean;
  /** User-level kill switch. */
  readonly killSwitch: boolean;
}

/**
 * Pure fan-out: given a whale fill event and the set of subscribers mirroring
 * that whale, produce one MirrorIntent per eligible subscriber.
 *
 * Eligibility = subscription is not paused AND user kill_switch is off.
 *
 * The intent is intentionally minimal: it carries only what the Order Router
 * needs to (a) identify the subscriber, (b) dedupe with the idempotency key,
 * and (c) reconstruct the order from current user/subscription state. We do
 * NOT bake operator-controlled fields into the intent — see threat
 * "operator front-run" in docs/phase-2.md §3.3.
 */
export function fanOutFill(
  fill: HlFillEvent,
  subscribers: readonly Subscriber[],
  now: number,
): MirrorIntent[] {
  const out: MirrorIntent[] = [];
  for (const s of subscribers) {
    if (s.paused || s.killSwitch) continue;
    if (s.whaleAddress !== fill.user) continue;
    out.push({
      idempotencyKey: `${fill.hash}:${s.id}`,
      subscriberId: s.id,
      whaleFillId: fill.hash,
      whaleAddress: fill.user,
      coin: fill.coin,
      side: fill.side,
      px: fill.px,
      sz: fill.sz,
      whaleTs: fill.time,
      emittedAt: now,
    });
  }
  return out;
}
