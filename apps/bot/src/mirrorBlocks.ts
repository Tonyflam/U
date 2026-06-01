/**
 * Mirror block sink: keeps a short-lived "do not mirror" flag per
 * (userId, coin). Set when the user manually /close-s a position;
 * checked by the mirror engine before submitting an order.
 *
 * Without this, a manual close leaves no signal — when the whale later
 * exits, the bot would mirror that exit as a fresh order in the opposite
 * direction (e.g. user had closed their long → whale's sell mirrors as
 * a fresh short for the user).
 *
 * Storage is Redis with TTL so the block self-clears, and survives bot
 * restarts. In-memory impl is also provided for tests.
 */
import type { Redis } from '@upstash/redis';

export interface MirrorBlockStore {
  block(userId: string, coin: string): Promise<void>;
  isBlocked(userId: string, coin: string): Promise<boolean>;
}

const DEFAULT_TTL_SEC = 24 * 60 * 60;

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

  async block(userId: string, coin: string): Promise<void> {
    await this.redis.set(key(userId, coin), Date.now(), { ex: this.ttlSec });
  }

  async isBlocked(userId: string, coin: string): Promise<boolean> {
    const v = await this.redis.get(key(userId, coin));
    return v !== null && v !== undefined;
  }
}

export class InMemoryMirrorBlockStore implements MirrorBlockStore {
  private readonly map = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(opts: { readonly ttlSec?: number } = {}) {
    this.ttlMs = (opts.ttlSec ?? DEFAULT_TTL_SEC) * 1000;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface; in-memory store has no IO
  async block(userId: string, coin: string): Promise<void> {
    this.map.set(key(userId, coin), Date.now() + this.ttlMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface; in-memory store has no IO
  async isBlocked(userId: string, coin: string): Promise<boolean> {
    const exp = this.map.get(key(userId, coin));
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      this.map.delete(key(userId, coin));
      return false;
    }
    return true;
  }
}
