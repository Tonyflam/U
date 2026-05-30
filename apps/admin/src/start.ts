/**
 * Production entry point for the admin bot.
 *
 * Topology mirrors `apps/bot/src/start.ts`:
 *   - Webhook (default) or polling (dev) Telegram bot.
 *   - Fastify `/healthz` for the platform.
 *   - SIGTERM/SIGINT graceful drain.
 *
 * Authorization model (defense in depth):
 *   1. Bot only listens to messages from chats whose `from.id` ∈ operator set
 *      (filter applied here).
 *   2. `handleAdminCommand` re-checks operator status itself.
 *   3. Every mutation appends an audit row tagged `op:${tgUserId}`.
 *
 * Operators come from `ADMIN_OPERATOR_TG_IDS` — a comma-separated list of
 * positive integers. Empty list ⇒ the bot refuses every command (safe default).
 */
import { Bot, webhookCallback, type Context } from 'grammy';
import Fastify from 'fastify';
import pino, { type Logger } from 'pino';
import { z } from 'zod';
import { parseEnv, commonEnv } from '@whalepod/config';
import { createDb } from '@whalepod/schema';
import {
  handleAdminCommand,
  parseAdminCommand,
  DrizzleAdminRepo,
  type AdminCtx,
  type AdminReply,
} from './index.js';

const adminEnv = commonEnv.extend({
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().min(40),
  TELEGRAM_ADMIN_WEBHOOK_SECRET: z.string().min(16).optional(),
  ADMIN_BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  ADMIN_BOT_PORT: z.coerce.number().int().positive().default(8082),
  ADMIN_OPERATOR_TG_IDS: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['require', 'prefer', 'disable']).default('require'),
});

export function parseOperatorIds(raw: string): ReadonlySet<bigint> {
  const out = new Set<bigint>();
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (s === '') continue;
    if (!/^\d+$/u.test(s)) throw new Error(`Invalid operator tg id: ${s}`);
    const n = BigInt(s);
    if (n <= 0n) throw new Error(`Operator tg id must be positive: ${s}`);
    out.add(n);
  }
  if (out.size === 0) throw new Error('ADMIN_OPERATOR_TG_IDS must contain at least one id');
  return out;
}

export interface AdminBotDeps {
  readonly token: string;
  readonly operators: ReadonlySet<bigint>;
  readonly repo: AdminCtx['repo'];
  readonly log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
}

const GENERIC_ERROR_TEXT = 'Sorry — something went wrong handling that command.';

export function createAdminBot(deps: AdminBotDeps): Bot {
  const bot = new Bot(deps.token);

  bot.on('message:text', async (gctx) => {
    const fromId = gctx.from.id;
    const text = gctx.message.text;
    if (typeof fromId !== 'number') return;
    const actorTgId = BigInt(fromId);
    if (!deps.operators.has(actorTgId)) {
      deps.log.warn({ actorTgId: actorTgId.toString() }, 'admin: non-operator message ignored');
      return;
    }
    const parsed = parseAdminCommand(text);
    if (parsed === null) return;
    try {
      const replies = await handleAdminCommand(parsed, {
        actorTgId,
        operators: deps.operators,
        repo: deps.repo,
      });
      for (const r of replies) await sendReply(gctx, r);
    } catch (err) {
      deps.log.error({ err, actorTgId: actorTgId.toString() }, 'admin: handler threw');
      await gctx.reply(GENERIC_ERROR_TEXT);
    }
  });

  bot.catch((err) => {
    deps.log.error({ err: err.error }, 'admin: bot error');
  });

  return bot;
}

async function sendReply(gctx: Context, reply: AdminReply): Promise<void> {
  await gctx.reply(reply.text);
}

async function main(): Promise<void> {
  const env = parseEnv(adminEnv, { dotenvPaths: ['.env'] });
  const log = pino({ level: env.LOG_LEVEL, name: 'admin' });
  const operators = parseOperatorIds(env.ADMIN_OPERATOR_TG_IDS);
  log.info({ count: operators.size }, 'operator allow-list loaded');

  const { db, client } = createDb({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL });
  const repo = new DrizzleAdminRepo(db);
  const bot = createAdminBot({
    token: env.TELEGRAM_ADMIN_BOT_TOKEN,
    operators,
    repo,
    log,
  });

  if (env.ADMIN_BOT_MODE === 'polling') {
    log.info('starting admin bot in long-polling mode');
    await bot.init();
    await bot.start({
      onStart: (me) => {
        log.info({ bot: me.username }, 'admin bot started');
      },
    });
    return;
  }

  if (!env.TELEGRAM_ADMIN_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_ADMIN_WEBHOOK_SECRET is required in webhook mode');
  }

  const app = Fastify({ loggerInstance: log });
  app.get('/healthz', () => {
    return { ok: true };
  });
  app.post(
    '/tg/admin/webhook',
    webhookCallback(bot, 'fastify', {
      secretToken: env.TELEGRAM_ADMIN_WEBHOOK_SECRET,
    }),
  );

  await app.listen({ port: env.ADMIN_BOT_PORT, host: '0.0.0.0' });
  log.info({ port: env.ADMIN_BOT_PORT }, 'admin webhook listening');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await app.close();
    await client.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('admin startup failed:', err);
    process.exit(1);
  });
}
