import type { Logger } from 'pino';
import { HlFillEvent, type MirrorIntent, type WatchFillEvent } from './types.js';
import { fanOutFill, type Subscriber } from './fanout.js';
import type { IntentSink } from './sink.js';
import type { WatchAlertSink } from './watchSink.js';

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

/**
 * Lookup: which Telegram users are watching this whale (free alerts, no
 * wallet)? `whaleAlias` rides along so the alert renderer can show a
 * friendly name without a second query.
 */
export interface WatcherLookup {
  watchersFor(whaleAddress: string): Promise<{
    readonly tgUserIds: readonly string[];
    readonly whaleAlias: string | null;
  }>;
}

export interface ConsumerOptions {
  readonly source: FillSource;
  readonly subscribers: SubscriberLookup;
  readonly sink: IntentSink;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  /**
   * Optional watcher fan-out. When both are present, every fill is also
   * delivered as a `WatchFillEvent` to each watcher of the whale. Failures
   * are logged and never affect the mirror path.
   */
  readonly watchers?: WatcherLookup;
  readonly watchSink?: WatchAlertSink;
  /**
   * Minimum USD notional (px × sz) a fill must clear to produce a watch
   * alert. Whales scale into positions with hundreds of small fills; without
   * a floor a single $60M position becomes hundreds of dust pings. Defaults
   * to {@link DEFAULT_WATCH_ALERT_MIN_NOTIONAL_USD}. The mirror path is
   * unaffected — per-subscription size caps govern that independently.
   */
  readonly watchMinNotionalUsd?: number;
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
 * Watch alerts only fire for fills younger than this. HL's `userFills`
 * subscribe-response replays a snapshot of historical fills on every
 * (re)connect; without this guard a reconnect would spam every watcher
 * with days-old fills presented as live. Mirror intents are protected
 * separately by sink idempotency + IOC pricing; alerts have no such
 * backstop, so we gate on the whale's own fill timestamp.
 */
export const WATCH_ALERT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Default minimum USD notional for a watch alert. A whale builds a large
 * position from many small fills; alerting on every one floods the channel
 * with dust (medians on real curated whales sit at $300–$4,000). $25k keeps
 * the feed to moves worth a copy-trader's attention while staying alive
 * (~40 alerts/day across the curated set). Tunable per deployment via the
 * `watchMinNotionalUsd` option (wired to an env var in start.ts).
 */
export const DEFAULT_WATCH_ALERT_MIN_NOTIONAL_USD = 25_000;

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
  const watchMinNotionalUsd = options.watchMinNotionalUsd ?? DEFAULT_WATCH_ALERT_MIN_NOTIONAL_USD;
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

    // Watcher fan-out is strictly best-effort and isolated from the mirror
    // path: a watcher-lookup or alert-sink failure must never block intents.
    // Two gates protect watchers from noise:
    //   1. Freshness — drop snapshot-replayed (stale) fills on reconnect.
    //   2. Notional — drop dust fills below the configured floor; whales
    //      scale positions with hundreds of small fills.
    const fillNotionalUsd = Number(fill.px) * Number(fill.sz);
    const fresh = now() - fill.time <= WATCH_ALERT_MAX_AGE_MS;
    const bigEnough = Number.isFinite(fillNotionalUsd) && fillNotionalUsd >= watchMinNotionalUsd;
    if (options.watchers && options.watchSink && fresh && bigEnough) {
      try {
        const { tgUserIds, whaleAlias } = await options.watchers.watchersFor(fill.user);
        if (tgUserIds.length > 0) {
          const event: WatchFillEvent = {
            fillHash: fill.hash,
            whaleAddress: fill.user,
            whaleAlias,
            coin: fill.coin,
            side: fill.side,
            px: fill.px,
            sz: fill.sz,
            whaleTs: fill.time,
          };
          for (const tgUserId of tgUserIds) {
            try {
              await options.watchSink.emit(event, tgUserId);
            } catch (err) {
              options.logger.error(
                { err, whale: fill.user, tgUserId },
                'ws-consumer: watch sink emit failed',
              );
            }
          }
        }
      } catch (err) {
        options.logger.error({ err, whale: fill.user }, 'ws-consumer: watcher lookup failed');
      }
    }
  }

  return stats;
}
