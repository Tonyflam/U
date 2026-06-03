/**
 * Production entry point for the bot service.
 *
 * Two modes (selected by `BOT_MODE`):
 *   - `webhook` (default in production): boots a Fastify HTTP server that
 *     mounts grammy's `webhookCallback` at `/tg/webhook`. Telegram's
 *     `X-Telegram-Bot-Api-Secret-Token` header is validated by grammy.
 *   - `polling`: dev/staging fallback that runs `bot.start()`. Don't run two
 *     pollers against the same token.
 *
 * Alongside the webhook, the bot drains the `mirror-intents` Redis stream
 * via `runMirrorConsumer` — every mirror submission runs through the same
 * process so we share KMS + Postgres connections.
 *
 * Health check at `GET /healthz` for the platform.
 *
 * On SIGTERM we flip the consumer controller, drain HTTP, close the DB
 * pool, and exit. Fly.io / k8s send SIGTERM with a 30s grace by default.
 */
import { createDb } from '@whalepod/schema';
import { parseEnv, commonEnv, KmsClient } from '@whalepod/config';
import { HttpHlTransport } from '@whalepod/sdk';
import { Redis } from '@upstash/redis';
import Fastify from 'fastify';
import pino from 'pino';
import { webhookCallback } from 'grammy';
import { z } from 'zod';
import { createBot } from './bot.js';
import { DrizzleBotRepo } from './drizzleBotRepo.js';
import {
  DrizzleAgentKeyLookup,
  DrizzleNotifyPrefsResolver,
  DrizzleTgUserIdResolver,
  DrizzleUserAddressLookup,
} from './drizzleLookups.js';
import { DrizzleSubscriptionSnapshotLookup, DrizzleUserSnapshotLookup } from './mirrorSnapshots.js';
import { HlAssetIndex } from './hlAssetIndex.js';
import { HlInfoEquity } from './hlInfoEquity.js';
import { HlLivePositions } from './hlLivePositions.js';
import { HlPnlSource } from './hlPnlSnapshot.js';
import { closePositions } from './positionCloser.js';
import { KmsAgentSigner } from './kmsAgentSigner.js';
import { TelegramMirrorAlerter } from './mirrorAlerter.js';
import { RedisDailyNotional } from './redisDailyNotional.js';
import { RedisGeoCache } from './redisGeoCache.js';
import { runMirrorConsumer, type ConsumerController } from './mirrorConsumer.js';
import { runNotifyConsumer } from './notifyConsumer.js';
import { RedisFillPublisher } from './fillPublisher.js';
import { DrizzleFillSink } from './fillSink.js';
import { RealizedPnlFillSink } from './realizedPnlSink.js';
import { RedisMirrorBlockStore } from './mirrorBlocks.js';
import { RedisShortLinkStore } from './shortLinks.js';
import { captureGeo, extractCountry, extractTgUserId } from './geoCapture.js';
import type { MirrorEngineDeps } from './mirrorEngine.js';
import type { SubmitMirrorDeps } from './submitMirror.js';
import type { PositionCloseFn } from './handlers.js';

const botEnv = commonEnv.extend({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,32}$/u)
    .transform((s) => s.replace(/^@/u, '')),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  BOT_PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_MINIAPP_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['require', 'prefer', 'disable']).default('require'),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  AWS_REGION: z.string().min(1),
  KMS_KEY_ID: z.string().min(1),
  HL_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  HL_API_URL: z.string().url(),
  BUILDER_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/u),
  MIRROR_CONSUMER_NAME: z.string().min(1).default('bot-1'),
  MIRROR_BATCH_SIZE: z.coerce.number().int().positive().default(32),
  RISK_MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(200),
  RISK_MAX_DAILY_NOTIONAL_USD: z.coerce.number().positive().default(1_000_000),
  RISK_BLOCKED_COUNTRIES: z.string().default(''),
  RISK_REQUIRE_KNOWN_GEO: z
    .union([z.boolean(), z.string()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    })
    .default(false),
  HL_ASSET_REFRESH_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  SHARE_TOKEN_SECRET: z.string().min(32).optional(),
  /**
   * Optional CSV of internal user IDs allowed to receive mirror orders.
   * When set, all other users are skipped with reason `not_in_allowlist`.
   * Used during the mainnet canary to keep blast radius small.
   * Empty / unset = allow everyone (production default).
   */
  MIRROR_USER_ALLOWLIST: z.string().optional(),
});

async function main(): Promise<void> {
  const env = parseEnv(botEnv, { dotenvPaths: ['.env'] });
  const log = pino({ level: env.LOG_LEVEL, name: 'bot' });

  const { db, client } = createDb({
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
  });
  const repo = new DrizzleBotRepo(db);

  // ─── mirror-intents consumer wiring ────────────────────────────────────────
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  const kms = new KmsClient({ region: env.AWS_REGION, keyId: env.KMS_KEY_ID });
  const transport = new HttpHlTransport({ baseUrl: env.HL_API_URL });

  // Mark prices feed /pnl unrealized math. We pre-warm once so the first
  // user that fires /pnl after boot sees live numbers rather than nulls.
  const { MarkPriceCache } = await import('./markPriceCache.js');
  const markPrices = new MarkPriceCache({ transport, refreshMs: env.HL_ASSET_REFRESH_MS });
  await markPrices.refresh().catch((err: unknown) => {
    log.warn({ err }, 'mark price prewarm failed');
  });
  markPrices.start();

  // The /close + /closeall handlers need signer/assets/audit which are built
  // further down (because they depend on `bot.api`). Hand the bot a proxy
  // that calls into a holder we fill in once those deps exist. Until then,
  // /close replies "temporarily unavailable" because the holder is undefined
  // and `createBot` only passes `closer` when truthy.
  // eslint-disable-next-line prefer-const -- reassigned at the bottom once signer/assets are ready
  let livePositionCloser: PositionCloseFn | undefined;
  const closerProxy: PositionCloseFn = (input) => {
    if (!livePositionCloser) {
      return Promise.resolve({ kind: 'no_positions' as const });
    }
    return livePositionCloser(input);
  };

  const mirrorBlocks = new RedisMirrorBlockStore({ redis });
  const shortLinks = new RedisShortLinkStore({ redis });

  const bot = createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    repo,
    miniAppUrl: env.PUBLIC_MINIAPP_URL,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    log,
    markPrice: markPrices.get(),
    hlPnl: new HlPnlSource(transport),
    closer: closerProxy,
    ...(env.SHARE_TOKEN_SECRET ? { shareTokenSecret: env.SHARE_TOKEN_SECRET } : {}),
    mirrorBlocks,
    shortLinks,
  });

  const userSnapshots = new DrizzleUserSnapshotLookup(db);
  const subSnapshots = new DrizzleSubscriptionSnapshotLookup(db);
  const addresses = new DrizzleUserAddressLookup(db);
  const agentKeys = new DrizzleAgentKeyLookup(db);

  const assets = new HlAssetIndex(transport);
  await assets.refresh();
  const assetRefreshTimer = setInterval(() => {
    assets.refresh().catch((err: unknown) => {
      log.warn({ err }, 'hl asset index refresh failed');
    });
  }, env.HL_ASSET_REFRESH_MS);
  assetRefreshTimer.unref();

  const engineDeps: MirrorEngineDeps = {
    users: userSnapshots,
    subscriptions: subSnapshots,
    assets,
    builderAddress: env.BUILDER_ADDRESS.toLowerCase() as `0x${string}`,
    mirrorBlocks,
    ...(env.MIRROR_USER_ALLOWLIST && env.MIRROR_USER_ALLOWLIST.trim().length > 0
      ? {
          userAllowlist: new Set(
            env.MIRROR_USER_ALLOWLIST.split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        }
      : {}),
  };

  const signer = new KmsAgentSigner({
    kms,
    keys: agentKeys,
    isMainnet: env.HL_NETWORK === 'mainnet',
  });
  const notionalSink = new RedisDailyNotional({ redis });
  const geoCache = new RedisGeoCache({ redis });
  const equity = new HlInfoEquity({ transport, addresses });

  const blockedCountries = env.RISK_BLOCKED_COUNTRIES.split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);

  let lastNonce = 0;
  const tgResolver = new DrizzleTgUserIdResolver(db);
  const fillPublisher = new RedisFillPublisher({
    redis,
    resolver: tgResolver,
    log: log.child({ component: 'fill-publisher' }),
  });
  const mirrorAlerter = new TelegramMirrorAlerter({
    api: bot.api,
    resolver: tgResolver,
    log: log.child({ component: 'mirror-alerter' }),
  });
  const fillSink = new RealizedPnlFillSink({
    inner: new DrizzleFillSink({
      db,
      log: log.child({ component: 'fill-sink' }),
    }),
  });
  const submitDeps: SubmitMirrorDeps = {
    risk: {
      accountEquity: equity,
      dailyNotional: notionalSink,
      geo: geoCache,
      policy: {
        maxSlippageBps: env.RISK_MAX_SLIPPAGE_BPS,
        maxDailyNotionalUsd: env.RISK_MAX_DAILY_NOTIONAL_USD,
        blockedCountries,
        requireKnownGeo: env.RISK_REQUIRE_KNOWN_GEO,
      },
    },
    signer,
    transport,
    notionalSink,
    audit: repo,
    publisher: fillPublisher,
    fillSink,
    now: () => Date.now(),
    nonce: () => {
      const n = Math.max(Date.now(), lastNonce + 1);
      lastNonce = n;
      return n;
    },
  };

  const livePositions = new HlLivePositions(transport);
  livePositionCloser = async ({ user, coin }) =>
    closePositions(
      {
        id: user.id,
        mainWallet: user.mainWallet as `0x${string}`,
        agentAddress: user.agentAddress as `0x${string}`,
        currentFeeTenthsBp: user.currentFeeTenthsBp,
        approvedMaxFeeTenthsBp: user.approvedMaxFeeTenthsBp,
      },
      coin,
      {
        positions: livePositions,
        assets,
        markPrice: markPrices.get(),
        signer,
        transport,
        audit: repo,
        builderAddress: env.BUILDER_ADDRESS.toLowerCase() as `0x${string}`,
        nonce: submitDeps.nonce,
        now: submitDeps.now,
        slippageBps: env.RISK_MAX_SLIPPAGE_BPS,
        pnlReader: repo,
        fillSink,
      },
    );

  const controller: ConsumerController = { stopped: false };
  const consumerPromise = runMirrorConsumer(
    {
      redis,
      engineDeps,
      submitDeps,
      log: log.child({ component: 'mirror-consumer' }),
      consumerName: env.MIRROR_CONSUMER_NAME,
      batchSize: env.MIRROR_BATCH_SIZE,
      alerter: mirrorAlerter,
    },
    controller,
  ).catch((err: unknown) => {
    log.error({ err }, 'mirror consumer crashed');
  });
  log.info({ consumer: env.MIRROR_CONSUMER_NAME }, 'mirror-intents consumer started');

  const notifyPromise = runNotifyConsumer(
    {
      redis,
      bot,
      log: log.child({ component: 'notify-consumer' }),
      consumerName: env.MIRROR_CONSUMER_NAME,
      batchSize: env.MIRROR_BATCH_SIZE,
      prefsResolver: new DrizzleNotifyPrefsResolver(db),
    },
    controller,
  ).catch((err: unknown) => {
    log.error({ err }, 'notify consumer crashed');
  });
  log.info({ consumer: env.MIRROR_CONSUMER_NAME }, 'mirror-fills consumer started');

  // ─── telegram surface ──────────────────────────────────────────────────────
  if (env.BOT_MODE === 'polling') {
    log.info('starting bot in long-polling mode');
    await bot.init();
    process.on('SIGTERM', () => {
      controller.stopped = true;
    });
    process.on('SIGINT', () => {
      controller.stopped = true;
    });
    await bot.start({
      onStart: (me) => {
        log.info({ bot: me.username }, 'bot started');
      },
    });
    await consumerPromise;
    await notifyPromise;
    return;
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required in webhook mode');
  }

  const app = Fastify({ loggerInstance: log });

  app.get('/healthz', () => {
    return { ok: true };
  });

  const handler = webhookCallback(bot, 'fastify', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
  });
  app.post(
    '/tg/webhook',
    {
      preHandler: (request, _reply, done) => {
        const country = extractCountry(request.headers['cf-ipcountry']);
        const tgUserId = extractTgUserId(request.body);
        if (country !== undefined && tgUserId !== undefined) {
          captureGeo({ repo, geoCache }, { tgUserId, country }).catch((err: unknown) => {
            log.warn({ err, tgUserId: tgUserId.toString() }, 'geo capture failed');
          });
        }
        done();
      },
    },
    handler,
  );

  const port = env.BOT_PORT;
  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'bot webhook listening');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    controller.stopped = true;
    clearInterval(assetRefreshTimer);
    await app.close();
    await consumerPromise;
    await notifyPromise;
    await client.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('bot startup failed:', err);
  process.exit(1);
});
