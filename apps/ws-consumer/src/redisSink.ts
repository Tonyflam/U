import type { Redis } from '@upstash/redis';
import type { IntentSink } from './sink.js';
import type { MirrorIntent } from './types.js';

/**
 * Redis-backed IntentSink.
 *
 * Two-step write: SETNX the idempotency key (with a 25h TTL — phase-2 §3.3
 * requires a 24h dedupe window plus margin); if it was new, XADD the
 * payload to the `mirror-intents` stream.
 *
 * Race note: if a process crashes between SETNX and XADD, that intent is
 * permanently lost (the dedupe key blocks retry). This is acceptable for the
 * mirror-fill use case — missed mirrors are surfaced by the consumer-side
 * fill confirmation loop in phase-2 §2 step 5, not by re-emitting from
 * ws-consumer. Trading rule: never auto-retry a stale market intent.
 */
export class RedisIntentSink implements IntentSink {
  constructor(
    private readonly redis: Redis,
    private readonly options: {
      readonly streamKey?: string;
      readonly dedupeKeyPrefix?: string;
      readonly dedupeTtlSec?: number;
      readonly maxStreamLen?: number;
    } = {},
  ) {}

  async emit(intent: MirrorIntent): Promise<boolean> {
    const streamKey = this.options.streamKey ?? 'mirror-intents';
    const dedupePrefix = this.options.dedupeKeyPrefix ?? 'mi:idem:';
    const ttl = this.options.dedupeTtlSec ?? 25 * 3600;
    const maxLen = this.options.maxStreamLen ?? 100_000;

    const wasNew = await this.redis.set(`${dedupePrefix}${intent.idempotencyKey}`, '1', {
      nx: true,
      ex: ttl,
    });
    if (wasNew === null) return false;

    await this.redis.xadd(
      streamKey,
      '*',
      { payload: JSON.stringify(intent) },
      { trim: { type: 'MAXLEN', threshold: maxLen, comparison: '~' } },
    );
    return true;
  }
}
