import type { Logger } from 'pino';
import { HlFillEvent, type MirrorIntent } from './types.js';
import { fanOutFill, type Subscriber } from './fanout.js';
import type { IntentSink } from './sink.js';

/**
 * Input source for raw whale fill events. Production binds this to an
 * `@nktkas/hyperliquid` WS subscription that publishes one event per
 * tracked whale's `userFills` update. Tests pass an async iterable directly.
 */
export interface FillSource {
  /**
   * Async iterable of raw events from upstream. Implementations are
   * responsible for reconnect + backfill on disconnect; the consumer loop
   * here is purely the per-event pipeline.
   */
  events(): AsyncIterable<unknown>;
}

/**
 * Lookup: who is mirroring this whale right now? Backed by Postgres in
 * production, in-memory in tests.
 */
export interface SubscriberLookup {
  subscribersFor(whaleAddress: string): Promise<readonly Subscriber[]>;
}

export interface ConsumerOptions {
  readonly source: FillSource;
  readonly subscribers: SubscriberLookup;
  readonly sink: IntentSink;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  /**
   * Optional clock override for tests. Defaults to `Date.now`. Result is
   * stamped onto `MirrorIntent.emittedAt`.
   */
  readonly now?: () => number;
}

export interface RunStats {
  readonly processed: number;
  readonly emitted: number;
  readonly dedupedAtSink: number;
  readonly invalid: number;
}

/**
 * Run the per-event pipeline to completion of the source's iterable.
 *
 * Pipeline per event:
 *   1. zod-parse the upstream payload (drop invalid).
 *   2. look up active subscribers for the whale.
 *   3. fan out → list of MirrorIntents.
 *   4. emit each through the sink; sink-level dedupe is authoritative.
 *
 * Errors in steps 2-4 are logged and the loop continues. Throwing inside
 * the per-event handler would surrender ordering guarantees for subsequent
 * events; the only authority that knows whether an intent landed is the
 * sink's return value.
 */
export async function runConsumer(options: ConsumerOptions): Promise<RunStats> {
  const now = options.now ?? Date.now;
  const stats = { processed: 0, emitted: 0, dedupedAtSink: 0, invalid: 0 };

  for await (const raw of options.source.events()) {
    const parsed = HlFillEvent.safeParse(raw);
    if (!parsed.success) {
      stats.invalid += 1;
      options.logger.warn({ issues: parsed.error.issues }, 'ws-consumer: invalid fill event');
      continue;
    }
    stats.processed += 1;
    const fill = parsed.data;

    let subscribers: readonly Subscriber[];
    try {
      subscribers = await options.subscribers.subscribersFor(fill.user);
    } catch (err) {
      options.logger.error({ err, whale: fill.user }, 'ws-consumer: subscriber lookup failed');
      continue;
    }

    const intents: readonly MirrorIntent[] = fanOutFill(fill, subscribers, now());
    for (const intent of intents) {
      try {
        const wasNew = await options.sink.emit(intent);
        if (wasNew) {
          stats.emitted += 1;
        } else {
          stats.dedupedAtSink += 1;
        }
      } catch (err) {
        options.logger.error({ err, key: intent.idempotencyKey }, 'ws-consumer: sink emit failed');
      }
    }
  }

  return stats;
}
