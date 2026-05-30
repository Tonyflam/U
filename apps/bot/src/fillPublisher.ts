/**
 * Mirror-fills publisher: writes a `MirrorFillEvent` to the `mirror-fills`
 * Redis stream so `notifyConsumer` can deliver it to the user via Telegram.
 *
 * Called by `submitMirror` after a successful HL ack. Failures are logged
 * and swallowed — a missing notification must never roll back the order
 * or crash the consumer loop. The audit row is the durable record.
 *
 * Stream entry shape (matches `notifyConsumer.readBatch`):
 *   payload   = JSON.stringify(MirrorFillEvent)
 *   tgUserId  = decimal string of the subscriber's Telegram user id
 */
import type { Redis } from '@upstash/redis';
import type { Logger } from 'pino';
import type { MirrorFillEvent } from './notify.js';

export interface TgUserIdResolver {
  /** Returns the subscriber's Telegram user id (as decimal string) or null. */
  tgUserIdByUserId(userId: string): Promise<string | null>;
}

export interface FillPublisher {
  publish(event: MirrorFillEvent, userId: string): Promise<void>;
}

export interface RedisFillPublisherOptions {
  readonly redis: Redis;
  readonly resolver: TgUserIdResolver;
  readonly log: Logger;
  readonly streamKey?: string;
  /** Optional MAXLEN ~ cap to bound stream growth in prod. */
  readonly maxLen?: number;
}

export class RedisFillPublisher implements FillPublisher {
  private readonly redis: Redis;
  private readonly resolver: TgUserIdResolver;
  private readonly log: Logger;
  private readonly streamKey: string;
  private readonly maxLen: number | undefined;

  constructor(opts: RedisFillPublisherOptions) {
    this.redis = opts.redis;
    this.resolver = opts.resolver;
    this.log = opts.log;
    this.streamKey = opts.streamKey ?? 'mirror-fills';
    this.maxLen = opts.maxLen;
  }

  async publish(event: MirrorFillEvent, userId: string): Promise<void> {
    let tgUserId: string | null;
    try {
      tgUserId = await this.resolver.tgUserIdByUserId(userId);
    } catch (err) {
      this.log.warn({ err, userId }, 'fill-publisher: tg lookup failed');
      return;
    }
    if (tgUserId === null) {
      this.log.warn({ userId }, 'fill-publisher: no tgUserId for user');
      return;
    }
    const fields = {
      payload: JSON.stringify(event),
      tgUserId,
    };
    try {
      if (this.maxLen !== undefined) {
        await this.redis.xadd(this.streamKey, '*', fields, {
          trim: { type: 'MAXLEN', threshold: this.maxLen, comparison: '~' },
        });
      } else {
        await this.redis.xadd(this.streamKey, '*', fields);
      }
    } catch (err) {
      this.log.warn({ err, userId, key: event.idempotencyKey }, 'fill-publisher: xadd failed');
    }
  }
}
