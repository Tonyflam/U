/**
 * Upstash Redis-backed daily-notional sink.
 *
 * Implements both halves of the risk-engine's notional contract:
 *
 *   - `add(userId, usd, atMs)`     — record one mirror submission
 *   - `usedUsd(userId, sinceMs)`   — sum the rolling 24h window
 *
 * Storage: one ZSET per user (key `notional:${userId}`), score = atMs,
 * member = `${atMs}:${usd}:${randomTag}` (tag avoids ZADD member collisions
 * when two submissions land in the same millisecond). We GC entries older
 * than 25h on each write so the set stays bounded.
 *
 * Atomicity: `add` performs ZADD + ZREMRANGEBYSCORE + EXPIRE in a pipeline
 * so a single round-trip writes both the data point and the GC. `usedUsd`
 * does ZRANGEBYSCORE in one call and sums client-side.
 */
import type { Redis } from '@upstash/redis';

const KEY_PREFIX = 'notional:';
const GC_LOOKBACK_MS = 25 * 60 * 60 * 1000;
const TTL_SEC = 26 * 60 * 60;

export interface RedisDailyNotionalOptions {
  readonly redis: Redis;
}

export class RedisDailyNotional {
  private readonly redis: Redis;

  constructor(options: RedisDailyNotionalOptions) {
    this.redis = options.redis;
  }

  private key(userId: string): string {
    return KEY_PREFIX + userId;
  }

  async add(userId: string, usd: number, atMs: number): Promise<void> {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const tag = Math.floor(Math.random() * 1e9).toString(36);
    const member = `${String(atMs)}:${usd.toString()}:${tag}`;
    const k = this.key(userId);
    const pipeline = this.redis.pipeline();
    pipeline.zadd(k, { score: atMs, member });
    pipeline.zremrangebyscore(k, 0, atMs - GC_LOOKBACK_MS);
    pipeline.expire(k, TTL_SEC);
    await pipeline.exec();
  }

  async usedUsd(userId: string, sinceMs: number): Promise<number> {
    const k = this.key(userId);
    const raw = await this.redis.zrange<string[]>(k, sinceMs, '+inf', {
      byScore: true,
    });
    let total = 0;
    for (const m of raw) {
      const parts = m.split(':');
      if (parts.length < 2) continue;
      const n = Number(parts[1]);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total;
  }
}
