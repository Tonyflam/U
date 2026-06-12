/**
 * Watch-fills stream consumer.
 *
 * Drains the `watch-fills` Redis stream (written by ws-consumer, one entry
 * per whale fill × watcher) and sends the rendered alert to the watcher via
 * grammy. Same lifecycle shape as `runNotifyConsumer` so it can be hosted
 * in the bot process under the same supervisor.
 *
 * Watchers are NOT users — there is no prefs lookup and no wallet gate.
 * Delivery is best-effort: failures are logged and the entry is acked
 * (a stuck entry would block every other watcher's alerts).
 */
import type { Redis } from '@upstash/redis';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { WatchFillEvent } from '@whalepod/ws-consumer';
import type { ConsumerController } from './mirrorConsumer.js';
import { ensureGroup } from './mirrorConsumer.js';
import { renderWatchAlert } from './watchNotify.js';

export interface WatchNotifyConsumerOptions {
  readonly redis: Redis;
  readonly bot: Bot;
  readonly log: Logger;
  readonly botUsername: string;
  readonly streamKey?: string;
  readonly groupName?: string;
  readonly consumerName: string;
  readonly batchSize?: number;
  readonly idleDelayMs?: number;
}

interface StreamEntry {
  readonly id: string;
  readonly payload: unknown;
  readonly tgUserId: string | undefined;
}

export async function runWatchNotifyConsumer(
  options: WatchNotifyConsumerOptions,
  controller: ConsumerController,
): Promise<void> {
  const streamKey = options.streamKey ?? 'watch-fills';
  const groupName = options.groupName ?? 'watch-notify';
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
        options.log.error({ err, entryId: entry.id }, 'watch-notify: handler threw');
      } finally {
        try {
          await options.redis.xack(streamKey, groupName, entry.id);
        } catch (ackErr) {
          options.log.error({ err: ackErr, entryId: entry.id }, 'watch-notify: xack failed');
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
  })) as
    | readonly [string, readonly [string, readonly unknown[] | Record<string, unknown>][]][]
    | null;
  if (!raw || raw.length === 0) return [];
  const out: StreamEntry[] = [];
  for (const [, list] of raw) {
    for (const [id, fields] of list) {
      let payload: unknown;
      let tgUserId: string | undefined;
      if (Array.isArray(fields)) {
        for (let i = 0; i < fields.length - 1; i += 2) {
          const k: unknown = fields[i];
          const v: unknown = fields[i + 1];
          if (k === 'payload') payload = v;
          else if (k === 'tgUserId') tgUserId = typeof v === 'string' ? v : String(v);
        }
      } else {
        const rec = fields as Record<string, unknown>;
        payload = rec['payload'];
        const t = rec['tgUserId'];
        tgUserId = t === undefined ? undefined : typeof t === 'string' ? t : String(t);
      }
      out.push({ id, payload, tgUserId });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleEntry(
  entry: StreamEntry,
  options: WatchNotifyConsumerOptions,
): Promise<void> {
  if (entry.payload === undefined || entry.payload === null || entry.tgUserId === undefined) {
    options.log.warn({ entryId: entry.id }, 'watch-notify: entry missing fields');
    return;
  }
  let parsed: unknown;
  if (typeof entry.payload === 'string') {
    try {
      parsed = JSON.parse(entry.payload);
    } catch (err) {
      options.log.warn({ err, entryId: entry.id }, 'watch-notify: invalid JSON payload');
      return;
    }
  } else {
    // Upstash auto-deserializes JSON values stored in streams.
    parsed = entry.payload;
  }
  const event = WatchFillEvent.safeParse(parsed);
  if (!event.success) {
    options.log.warn(
      { entryId: entry.id, err: event.error.message },
      'watch-notify: event failed schema validation',
    );
    return;
  }
  let tgUserId: number;
  try {
    tgUserId = Number(BigInt(entry.tgUserId));
  } catch {
    options.log.warn({ entryId: entry.id, tgUserId: entry.tgUserId }, 'watch-notify: bad tgUserId');
    return;
  }
  const reply = renderWatchAlert(event.data, { botUsername: options.botUsername });
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
    options.log.warn({ err, tgUserId, entryId: entry.id }, 'watch-notify: telegram send failed');
  }
}
