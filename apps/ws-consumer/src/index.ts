/**
 * @whalepod/ws-consumer — subscribes to Hyperliquid `userFills` for tracked
 * whales, fans out to per-subscriber MirrorIntents, dedupes, and emits to
 * the `mirror-intents` Redis stream.
 *
 * This module exports the pure pipeline pieces. The wiring (live HL WS,
 * Postgres subscriber lookup, Upstash Redis sink, reconnect loop) lands in
 * U16 dress-rehearsal where we have all three external systems available.
 */
export { backoffMs } from './backoff.js';
export { fanOutFill, type Subscriber } from './fanout.js';
export {
  runConsumer,
  type ConsumerOptions,
  type FillSource,
  type RunStats,
  type SubscriberLookup,
} from './consumer.js';
export { InMemoryIntentSink, type IntentSink } from './sink.js';
export { RedisIntentSink } from './redisSink.js';
export { HlFillEvent, MirrorIntent } from './types.js';
export {
  HlWebSocketSource,
  type HlWsSourceOptions,
  type WsLike,
  type WsFactory,
} from './hlWsSource.js';
