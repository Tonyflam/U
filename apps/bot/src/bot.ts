/**
 * Bot composition root.
 *
 * Wires the pure handler layer to:
 *   - grammy (Telegram Bot API)
 *   - Drizzle/Postgres (BotRepo)
 *   - pino (structured logs)
 *
 * Exposes `createBot(deps)` that returns a configured `grammy.Bot` ready to
 * either (a) launch via long-polling for local dev, or (b) be mounted as a
 * webhook handler in production. The actual `start()` entry lives in
 * `start.ts` and is the file referenced by `package.json#scripts.start`.
 *
 * Security:
 *   - The grammy webhook adapter MUST be mounted with the secret-token check
 *     (`webhookCallback(bot, 'fastify', { secretToken: env.TELEGRAM_WEBHOOK_SECRET })`).
 *     Without it any internet host can POST forged updates.
 *   - We never log message text at info level — only command kinds.
 *   - Unhandled handler errors don't bubble to grammy (which would crash the
 *     whole bot); they are caught and logged with a generic user-facing reply.
 */
import { Bot, type Context } from 'grammy';
import type { Logger } from 'pino';
import {
  handleCommand,
  type BotRepo,
  type MirrorBlockSink,
  type PositionCloseFn,
  type Reply,
} from './handlers.js';
import type { MarkPriceFn } from './pnl.js';
import { parseCommand } from './router.js';

export interface BotDeps {
  readonly token: string;
  readonly repo: BotRepo;
  readonly miniAppUrl: string;
  readonly botUsername: string;
  readonly log: Logger;
  /** Optional live mark-price source; injected when available. */
  readonly markPrice?: MarkPriceFn;
  /** Optional reduce-only position closer for /close + /closeall. */
  readonly closer?: PositionCloseFn;
  /** Optional HMAC secret for minting trade-share tokens. */
  readonly shareTokenSecret?: string;
  /** Optional sink for blocking mirror orders on coins the user just closed. */
  readonly mirrorBlocks?: MirrorBlockSink;
}

const GENERIC_ERROR_REPLY = 'Something went wrong on our end. Try again in a moment.';

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);

  bot.on('message:text', async (ctx) => {
    await handleTextMessage(ctx, deps);
  });

  // grammy's global error handler: never let an unhandled rejection take down
  // the long-poll loop or fail a webhook delivery (Telegram retries on 5xx
  // and exponential backoff can break the bot during outages).
  bot.catch((err) => {
    deps.log.error({ err }, 'unhandled bot error');
  });

  return bot;
}

async function handleTextMessage(ctx: Context, deps: BotDeps): Promise<void> {
  const text = ctx.message?.text;
  const from = ctx.from;
  if (!text || !from) return;

  const command = parseCommand(text);
  if (!command) return; // Not a command — ignore.

  deps.log.info({ cmd: command.kind, tg: from.id }, 'bot.command');

  let replies: readonly Reply[];
  try {
    replies = await handleCommand(command, {
      tgUser: { id: BigInt(from.id), username: from.username ?? null },
      repo: deps.repo,
      miniAppUrl: deps.miniAppUrl,
      botUsername: deps.botUsername,
      ...(deps.markPrice ? { markPrice: deps.markPrice } : {}),
      ...(deps.closer ? { closer: deps.closer } : {}),
      ...(deps.shareTokenSecret ? { shareTokenSecret: deps.shareTokenSecret } : {}),
      ...(deps.mirrorBlocks ? { mirrorBlocks: deps.mirrorBlocks } : {}),
    });
  } catch (err) {
    deps.log.error({ err, cmd: command.kind, tg: from.id }, 'bot.handler.error');
    await ctx.reply(GENERIC_ERROR_REPLY).catch((sendErr: unknown) => {
      deps.log.error({ err: sendErr }, 'bot.error_reply.failed');
    });
    return;
  }

  for (const reply of replies) {
    await sendReply(ctx, reply, deps.log);
  }
}

async function sendReply(ctx: Context, reply: Reply, log: Logger): Promise<void> {
  try {
    if (reply.buttons && reply.buttons.length > 0) {
      await ctx.reply(reply.text, {
        reply_markup: {
          inline_keyboard: reply.buttons.map((row) =>
            row.map((b) => ({ text: b.label, url: b.url })),
          ),
        },
      });
    } else {
      await ctx.reply(reply.text);
    }
  } catch (err) {
    log.error({ err }, 'bot.reply.failed');
  }
}
