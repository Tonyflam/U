/**
 * Upstash Redis-backed country cache for the risk engine's `geo.countryFor`.
 *
 * Country is captured at the API edge (Cloudflare `cf-ipcountry` header on
 * the Telegram webhook + miniapp routes) and stamped here whenever we see a
 * fresh value. The risk engine only reads. TTL keeps the value warm but
 * forces a re-stamp if the user is inactive for `ttlSec` seconds.
 */
import type { Redis } from '@upstash/redis';

const KEY_PREFIX = 'geo:';
const DEFAULT_TTL_SEC = 24 * 60 * 60;

export interface RedisGeoCacheOptions {
  readonly redis: Redis;
  readonly ttlSec?: number;
}

export class RedisGeoCache {
  private readonly redis: Redis;
  private readonly ttl: number;

  constructor(options: RedisGeoCacheOptions) {
    this.redis = options.redis;
    this.ttl = options.ttlSec ?? DEFAULT_TTL_SEC;
  }

  async set(userId: string, country: string): Promise<void> {
    const normalized = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/u.test(normalized)) return;
    await this.redis.set(KEY_PREFIX + userId, normalized, { ex: this.ttl });
  }

  async countryFor(userId: string): Promise<string | undefined> {
    const v = await this.redis.get<string>(KEY_PREFIX + userId);
    return v ?? undefined;
  }
}
