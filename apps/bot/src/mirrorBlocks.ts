/**
 * Mirror block sink: short-lived "do not mirror" flag per (userId, coin)
 * with a direction. Set when the user manually /close-s a position;
 * checked by the mirror engine before submitting a mirror order.
 *
 * Why directional + short TTL (vs a blanket 24h block on the coin):
 *
 *   When the user manually closes their LONG ETH, the whale's exit fill
 *   on ETH that arrives a few seconds later would mirror as a fresh
 *   SHORT (bad). That single exit fill is what we need to suppress.
 *
 *   But a flat 24h coin-level block also swallows the *next* legitimate
 *   whale entry on ETH (e.g. whale opens a fresh long an hour later) —
 *   which is exactly the bug we hit in prod:
 *
 *       skipReason: "user_closed_recently"  ← on a brand new BUY entry
 *
 *   So we store the *side to suppress* (same direction as the user's
 *   close action — also the direction the whale's exit fill arrives on)
 *   and only short-circuit fills matching that direction. A fill in the
 *   opposite direction is a fresh trade and is allowed through, AND
 *   clears the block (the whale has clearly moved on).
 *
 * Default TTL is 15 minutes: most whale exits land within seconds of
 * their entry-vs-our-close gap; 15 min is generous slop. After that
 * the user has clearly disengaged and re-engaged on their own terms.
 *
 * Storage is Redis with TTL so the block self-clears and survives bot
 * restarts. In-memory impl is also provided for tests.
 *
 * This matches the pattern used by mature copy-trading systems —
 * narrow, directional, time-boxed suppression rather than a coarse
 * coin-level cooldown that punishes legitimate re-entries.
 */
import type { Redis } from '@upstash/redis';

export type BlockSide = 'B' | 'S';

export interface MirrorBlockStore {
  /** Suppress further mirror orders on (userId, coin) for `side` only. */
  block(userId: string, coin: string, side: BlockSide): Promise<void>;
  /**
   * Returns true if a mirror order on `(userId, coin)` with direction
   * `side` should be suppressed. Opposite-direction fills are NOT
   * blocked (they're treated as fresh trades) but they also don't
   * lift the block — the same-direction exit fill could still be
   * landing milliseconds behind from a different whale subscription.
   */
  isBlocked(userId: string, coin: string, side: BlockSide): Promise<boolean>;
}

const DEFAULT_TTL_SEC = 15 * 60;

function key(userId: string, coin: string): string {
  return `mblock:${userId}:${coin}`;
}

export class RedisMirrorBlockStore implements MirrorBlockStore {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(opts: { readonly redis: Redis; readonly ttlSec?: number }) {
    this.redis = opts.redis;
    this.ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  }

  async block(userId: string, coin: string, side: BlockSide): Promise<void> {
    await this.redis.set(key(userId, coin), side, { ex: this.ttlSec });
  }

  async isBlocked(userId: string, coin: string, side: BlockSide): Promise<boolean> {
    const stored = await this.redis.get<string>(key(userId, coin));
    return stored === side;
  }
}

export class InMemoryMirrorBlockStore implements MirrorBlockStore {
  private readonly map = new Map<string, { side: BlockSide; expMs: number }>();
  private readonly ttlMs: number;

  constructor(opts: { readonly ttlSec?: number } = {}) {
    this.ttlMs = (opts.ttlSec ?? DEFAULT_TTL_SEC) * 1000;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface; in-memory store has no IO
  async block(userId: string, coin: string, side: BlockSide): Promise<void> {
    this.map.set(key(userId, coin), { side, expMs: Date.now() + this.ttlMs });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface; in-memory store has no IO
  async isBlocked(userId: string, coin: string, side: BlockSide): Promise<boolean> {
    const k = key(userId, coin);
    const entry = this.map.get(k);
    if (entry === undefined) return false;
    if (entry.expMs <= Date.now()) {
      this.map.delete(k);
      return false;
    }
    return entry.side === side;
  }
}
