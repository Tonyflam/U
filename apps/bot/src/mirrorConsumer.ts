/**
 * Mirror-intents stream consumer.
 *
 * Drains the `mirror-intents` Redis stream (populated by `ws-consumer`)
 * and runs each intent through `evaluateMirror` → `submitMirror`. Uses an
 * Upstash Redis consumer group so multiple bot replicas can split the
 * load; each replica acks its own batch via `XACK`.
 *
 * The loop is intentionally simple:
 *
 *   loop:
 *     XREADGROUP COUNT n BLOCK 5000 STREAMS mirror-intents >
 *     for each entry:
 *       parse payload → evaluateMirror → submitMirror
 *       XACK   (always — outcome is recorded in audit_log)
 *
 * Failed deliveries (parse error, handler throw) are still ACKed; the
 * audit row + structured log line is the durable record. Re-delivery on
 * the same intent is blocked by the per-`idempotencyKey` SETNX in
 * `RedisIntentSink`, so we can't auto-retry without rebuilding that
 * machinery anyway.
 *
 * Shutdown: caller flips `controller.stopped = true` (e.g. on SIGTERM)
 * and `run()` returns after the in-flight batch finishes.
 */
import type { Redis } from '@upstash/redis';
import type { Logger } from 'pino';
import { MirrorIntent } from '@whalepod/ws-consumer';
import { evaluateMirror, type MirrorEngineDeps } from './mirrorEngine.js';
import { submitMirror, type MirrorOutcome, type SubmitMirrorDeps } from './submitMirror.js';

export interface MirrorConsumerOptions {
  readonly redis: Redis;
  readonly engineDeps: MirrorEngineDeps;
  readonly submitDeps: SubmitMirrorDeps;
  readonly log: Logger;
  readonly streamKey?: string;
  readonly groupName?: string;
  readonly consumerName: string;
  readonly batchSize?: number;
  /** Idle poll delay when the stream returns no entries (ms). */
  readonly idleDelayMs?: number;
  /** Optional sink used to notify users via Telegram when a mirror fails. */
  readonly alerter?: MirrorAlerter;
}

export interface MirrorAlerter {
  alert(input: {
    readonly userId: string;
    readonly whaleAddress: string;
    readonly coin: string | number;
    readonly side: 'B' | 'S';
    readonly outcome: MirrorOutcome;
  }): Promise<void>;
}

export interface ConsumerController {
  stopped: boolean;
}

export async function ensureGroup(
  redis: Redis,
  streamKey: string,
  groupName: string,
): Promise<void> {
  try {
    await redis.xgroup(streamKey, {
      type: 'CREATE',
      group: groupName,
      id: '$',
      options: { MKSTREAM: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

interface StreamEntry {
  readonly id: string;
  readonly payload: unknown;
}

/**
 * Run the consumer loop until `controller.stopped` is set. One invocation
 * per worker. Safe to start N replicas with distinct `consumerName` values.
 */
export async function runMirrorConsumer(
  options: MirrorConsumerOptions,
  controller: ConsumerController,
): Promise<void> {
  const streamKey = options.streamKey ?? 'mirror-intents';
  const groupName = options.groupName ?? 'order-router';
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
        options.log.error(
          { err, entryId: entry.id },
          'mirror-consumer: handler threw — acking anyway',
        );
      } finally {
        try {
          await options.redis.xack(streamKey, groupName, entry.id);
        } catch (ackErr) {
          options.log.error({ err: ackErr, entryId: entry.id }, 'mirror-consumer: xack failed');
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
  })) as readonly [string, readonly [string, unknown][]][] | null;
  if (!raw || raw.length === 0) return [];
  const out: StreamEntry[] = [];
  for (const [, list] of raw) {
    for (const [id, fields] of list) {
      // Upstash returns fields as a flat array [key, value, key, value, ...].
      // Older shape was a Record. Support both.
      let payload: unknown;
      if (Array.isArray(fields)) {
        for (let i = 0; i < fields.length - 1; i += 2) {
          if (fields[i] === 'payload') {
            payload = fields[i + 1];
            break;
          }
        }
      } else if (fields && typeof fields === 'object') {
        payload = (fields as Record<string, unknown>)['payload'];
      }
      out.push({ id, payload });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleEntry(
  entry: StreamEntry,
  options: MirrorConsumerOptions,
): Promise<MirrorOutcome | undefined> {
  if (entry.payload === undefined || entry.payload === null) {
    options.log.warn({ entryId: entry.id }, 'mirror-consumer: entry missing payload');
    return undefined;
  }
  let parsed: unknown;
  if (typeof entry.payload === 'string') {
    try {
      parsed = JSON.parse(entry.payload);
    } catch (err) {
      options.log.warn({ err, entryId: entry.id }, 'mirror-consumer: invalid JSON payload');
      return undefined;
    }
  } else {
    // Upstash auto-deserializes JSON values stored in streams.
    parsed = entry.payload;
  }
  const intent = MirrorIntent.safeParse(parsed);
  if (!intent.success) {
    options.log.warn(
      { entryId: entry.id, err: intent.error.message },
      'mirror-consumer: intent failed schema validation',
    );
    return undefined;
  }
  const decision = await evaluateMirror(intent.data, options.engineDeps);
  const outcome = await submitMirror(decision, options.submitDeps);
  const detail: Record<string, unknown> = {
    entryId: entry.id,
    idempotencyKey: intent.data.idempotencyKey,
    subscriberId: intent.data.subscriberId,
    outcome: outcome.kind,
  };
  if (outcome.kind === 'skipped') detail['skipReason'] = outcome.reason;
  if (outcome.kind === 'risk_blocked') {
    detail['riskReason'] = outcome.reason;
    if (outcome.detail !== undefined) detail['riskDetail'] = outcome.detail;
  }
  if (outcome.kind === 'exchange_error' || outcome.kind === 'transport_error') {
    detail['errorMessage'] = outcome.message;
  }
  options.log.info(detail, 'mirror-consumer: processed');

  if (
    options.alerter !== undefined &&
    (outcome.kind === 'risk_blocked' ||
      outcome.kind === 'transport_error' ||
      outcome.kind === 'exchange_error')
  ) {
    try {
      await options.alerter.alert({
        userId: intent.data.subscriberId,
        whaleAddress: intent.data.whaleAddress,
        coin: intent.data.coin,
        side: intent.data.side,
        outcome,
      });
    } catch (err) {
      options.log.warn({ err, entryId: entry.id }, 'mirror-consumer: alerter failed');
    }
  }

  return outcome;
}
