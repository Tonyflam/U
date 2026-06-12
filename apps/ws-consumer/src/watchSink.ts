/**
 * Watch-alert sink: delivery channel for whale-fill alerts to watchers.
 *
 * Production: Redis-backed, appending one entry per (fill × watcher) to the
 * `watch-fills` stream with the same `{ payload, tgUserId }` envelope the
 * `mirror-fills` stream uses, so the bot-side consumer loop is symmetric.
 *
 * Dedupe: SETNX on `wf:idem:<fillHash>:<tgUserId>` with a 25h TTL. A missed
 * alert after a crash between SETNX and XADD is acceptable — watch alerts
 * are best-effort pings, not money movement.
 */
import type { Redis } from '@upstash/redis';
import type { WatchFillEvent } from './types.js';

export interface WatchAlertSink {
  /**
   * Emit one alert for one watcher. Returns true when newly recorded,
   * false when deduped.
   */
  emit(event: WatchFillEvent, tgUserId: string): Promise<boolean>;
}

/** Test/in-memory sink with explicit recall. */
export class InMemoryWatchAlertSink implements WatchAlertSink {
  readonly recorded: { readonly event: WatchFillEvent; readonly tgUserId: string }[] = [];
  private readonly seen = new Set<string>();

  emit(event: WatchFillEvent, tgUserId: string): Promise<boolean> {
    const key = `${event.fillHash}:${tgUserId}`;
    if (this.seen.has(key)) return Promise.resolve(false);
    this.seen.add(key);
    this.recorded.push({ event, tgUserId });
    return Promise.resolve(true);
  }
}

export class RedisWatchAlertSink implements WatchAlertSink {
  constructor(
    private readonly redis: Redis,
    private readonly options: {
      readonly streamKey?: string;
      readonly dedupeKeyPrefix?: string;
      readonly dedupeTtlSec?: number;
      readonly maxStreamLen?: number;
    } = {},
  ) {}

  async emit(event: WatchFillEvent, tgUserId: string): Promise<boolean> {
    const streamKey = this.options.streamKey ?? 'watch-fills';
    const dedupePrefix = this.options.dedupeKeyPrefix ?? 'wf:idem:';
    const ttl = this.options.dedupeTtlSec ?? 25 * 3600;
    const maxLen = this.options.maxStreamLen ?? 10_000;

    const wasNew = await this.redis.set(`${dedupePrefix}${event.fillHash}:${tgUserId}`, '1', {
      nx: true,
      ex: ttl,
    });
    if (wasNew === null) return false;

    await this.redis.xadd(
      streamKey,
      '*',
      { payload: JSON.stringify(event), tgUserId },
      { trim: { type: 'MAXLEN', threshold: maxLen, comparison: '~' } },
    );
    return true;
  }
}
