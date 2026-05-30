/**
 * Notify-fills stream consumer.
 *
 * Drains a `mirror-fills` Redis stream of `MirrorFillEvent` payloads
 * (written by the order router after each successful mirror submit) and
 * sends a rendered notification to the user via grammy. Same lifecycle
 * shape as `runMirrorConsumer` so both can be hosted in the bot process.
 *
 * The stream entry must carry both a `payload` (JSON of MirrorFillEvent)
 * and a `tgUserId` (decimal string) so the dispatcher knows where to
 * deliver. The order router is the natural place to add that field —
 * it already knows which subscriber the mirror belongs to.
 *
 * Failures are logged and acked: Telegram delivery is best-effort, and a
 * stuck entry would block the whole queue. The audit log on the order
 * router side is the durable record of what was *attempted*.
 */
import type { Redis } from '@upstash/redis';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { MirrorFillEvent, renderFillNotification, type NotifyPrefs } from './notify.js';
import type { ConsumerController } from './mirrorConsumer.js';
import { ensureGroup } from './mirrorConsumer.js';

export interface NotifyPrefsResolver {
  /** Returns per-user notification prefs by Telegram numeric user id. Null on miss. */
  prefsByTgUserId(tgUserId: string): Promise<NotifyPrefs | null>;
}

export interface NotifyConsumerOptions {
  readonly redis: Redis;
  readonly bot: Bot;
  readonly log: Logger;
  readonly streamKey?: string;
  readonly groupName?: string;
  readonly consumerName: string;
  readonly batchSize?: number;
  readonly idleDelayMs?: number;
  /** Default per-user prefs used when no resolver is wired or the resolver returns null. */
  readonly prefs?: NotifyPrefs;
  /** Optional per-user prefs lookup. When set, muted users are skipped. */
  readonly prefsResolver?: NotifyPrefsResolver;
}

interface StreamEntry {
  readonly id: string;
  readonly payload: string | undefined;
  readonly tgUserId: string | undefined;
}

export async function runNotifyConsumer(
  options: NotifyConsumerOptions,
  controller: ConsumerController,
): Promise<void> {
  const streamKey = options.streamKey ?? 'mirror-fills';
  const groupName = options.groupName ?? 'notify';
  const batch = options.batchSize ?? 32;
  const idleDelayMs = options.idleDelayMs ?? 500;

  await ensureGroup(options.redis, streamKey, groupName);

  while (!controller.stopped) {
    const entries = await readBatch(options.redis, {
      streamKey,
      groupName,
      consumerName: options.consumerName,
      batch,
    });
    if (entries.length === 0) {
      await sleep(idleDelayMs);
      continue;
    }
    for (const entry of entries) {
      try {
        await handleEntry(entry, options);
      } catch (err) {
        options.log.error({ err, entryId: entry.id }, 'notify-consumer: handler threw');
      } finally {
        try {
          await options.redis.xack(streamKey, groupName, entry.id);
        } catch (ackErr) {
          options.log.error({ err: ackErr, entryId: entry.id }, 'notify-consumer: xack failed');
        }
      }
    }
  }
}

async function readBatch(
  redis: Redis,
  opts: {
    readonly streamKey: string;
    readonly groupName: string;
    readonly consumerName: string;
    readonly batch: number;
  },
): Promise<readonly StreamEntry[]> {
  const raw = (await redis.xreadgroup(opts.groupName, opts.consumerName, opts.streamKey, '>', {
    count: opts.batch,
  })) as readonly [string, readonly [string, Record<string, string>][]][] | null;
  if (!raw || raw.length === 0) return [];
  const out: StreamEntry[] = [];
  for (const [, list] of raw) {
    for (const [id, fields] of list) {
      out.push({
        id,
        payload: fields['payload'],
        tgUserId: fields['tgUserId'],
      });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleEntry(
  entry: StreamEntry,
  options: NotifyConsumerOptions,
): Promise<void> {
  if (entry.payload === undefined || entry.tgUserId === undefined) {
    options.log.warn({ entryId: entry.id }, 'notify-consumer: entry missing fields');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payload);
  } catch (err) {
    options.log.warn({ err, entryId: entry.id }, 'notify-consumer: invalid JSON payload');
    return;
  }
  const event = MirrorFillEvent.safeParse(parsed);
  if (!event.success) {
    options.log.warn(
      { entryId: entry.id, err: event.error.message },
      'notify-consumer: event failed schema validation',
    );
    return;
  }
  let tgUserId: number;
  try {
    tgUserId = Number(BigInt(entry.tgUserId));
  } catch {
    options.log.warn(
      { entryId: entry.id, tgUserId: entry.tgUserId },
      'notify-consumer: bad tgUserId',
    );
    return;
  }
  let prefs: NotifyPrefs = options.prefs ?? {};
  if (options.prefsResolver) {
    try {
      const looked = await options.prefsResolver.prefsByTgUserId(entry.tgUserId);
      if (looked) prefs = { ...prefs, ...looked };
    } catch (err) {
      options.log.warn(
        { err, tgUserId, entryId: entry.id },
        'notify-consumer: prefs lookup failed, using defaults',
      );
    }
  }
  const reply = renderFillNotification(event.data, prefs);
  if (prefs.muted === true) {
    options.log.debug({ tgUserId, entryId: entry.id }, 'notify-consumer: user muted, skipping');
    return;
  }
  try {
    if (reply.buttons && reply.buttons.length > 0) {
      await options.bot.api.sendMessage(tgUserId, reply.text, {
        reply_markup: {
          inline_keyboard: reply.buttons.map((row) =>
            row.map((b) => ({ text: b.label, url: b.url })),
          ),
        },
      });
    } else {
      await options.bot.api.sendMessage(tgUserId, reply.text);
    }
  } catch (err) {
    options.log.warn({ err, tgUserId, entryId: entry.id }, 'notify-consumer: telegram send failed');
  }
}
