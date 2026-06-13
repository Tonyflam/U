/**
 * Production entry point for the ws-consumer service.
 *
 * Wires:
 *   - Postgres (DrizzleSubscriberLookup, whale-list refresher)
 *   - Upstash Redis sink (`mirror-intents` stream)
 *   - Live Hyperliquid WS source (auto-reconnect, re-subscribe)
 *   - Health endpoint on `WS_CONSUMER_HEALTH_PORT`
 *
 * On SIGTERM: stop the WS source, drain the consumer loop, close DB +
 * health server, exit.
 */
import { Redis } from '@upstash/redis';
import { createDb } from '@whalepod/schema';
import { parseEnv, commonEnv } from '@whalepod/config';
import Fastify from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { runConsumer } from './consumer.js';
import { RedisIntentSink } from './redisSink.js';
import { RedisWatchAlertSink } from './watchSink.js';
import { HlWebSocketSource } from './hlWsSource.js';
import { createWs } from './nodeWs.js';
import {
  DrizzleSubscriberLookup,
  DrizzleWatcherLookup,
  fetchActiveWhaleAddresses,
} from './drizzleSubscriberLookup.js';

const wsEnv = commonEnv.extend({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['require', 'prefer', 'disable']).default('require'),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  HL_WS_URL: z.string().url().default('wss://api.hyperliquid.xyz/ws'),
  WS_CONSUMER_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
  WS_CONSUMER_WHALE_REFRESH_SEC: z.coerce.number().int().positive().default(60),
  // Minimum USD notional (px × sz) for a fill to produce a watch alert.
  // Filters dust; whales scale positions with many small fills. Raise to make
  // the public alerts channel quieter / more "big move" only.
  WATCH_ALERT_MIN_NOTIONAL_USD: z.coerce.number().nonnegative().default(50_000),
});

async function main(): Promise<void> {
  const env = parseEnv(wsEnv, { dotenvPaths: ['.env'] });
  const log = pino({ level: env.LOG_LEVEL, name: 'ws-consumer' });

  const { db, client } = createDb({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  const sink = new RedisIntentSink(redis);
  const subscribers = new DrizzleSubscriberLookup(db);
  const watchers = new DrizzleWatcherLookup(db);
  const watchSink = new RedisWatchAlertSink(redis);

  const initialWhales = await fetchActiveWhaleAddresses(db);
  log.info({ count: initialWhales.length }, 'initial whale set loaded');

  const source = new HlWebSocketSource({
    url: env.HL_WS_URL,
    whales: initialWhales,
    logger: log,
    wsFactory: createWs,
  });
  source.start();

  const refreshTimer = setInterval(() => {
    fetchActiveWhaleAddresses(db)
      .then((next) => {
        source.setWhales(next);
        log.debug({ count: next.length }, 'refreshed whale set');
      })
      .catch((err: unknown) => {
        log.error({ err }, 'whale refresh failed');
      });
  }, env.WS_CONSUMER_WHALE_REFRESH_SEC * 1000);

  const app = Fastify({ loggerInstance: log });
  app.get('/healthz', () => {
    return { ok: true };
  });
  await app.listen({ port: env.WS_CONSUMER_HEALTH_PORT, host: '0.0.0.0' });

  const stats = runConsumer({
    source,
    subscribers,
    sink,
    watchers,
    watchSink,
    watchMinNotionalUsd: env.WATCH_ALERT_MIN_NOTIONAL_USD,
    logger: log,
  });
  stats
    .then((s) => {
      log.info({ stats: s }, 'consumer loop ended');
    })
    .catch((err: unknown) => {
      log.error({ err }, 'consumer loop crashed');
    });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    clearInterval(refreshTimer);
    source.stop();
    await app.close();
    await client.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('ws-consumer startup failed:', err);
  process.exit(1);
});
