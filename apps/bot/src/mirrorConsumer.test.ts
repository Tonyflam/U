/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { runMirrorConsumer, type ConsumerController } from './mirrorConsumer.js';
import type { MirrorEngineDeps, MirrorDecision } from './mirrorEngine.js';
import type { SubmitMirrorDeps, MirrorOutcome } from './submitMirror.js';
import type { Logger } from 'pino';

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => makeLog(),
  } as unknown as Logger;
}

function intent(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'fill-1:sub-1',
    subscriberId: '11111111-1111-1111-1111-111111111111',
    whaleFillId: 'fill-1',
    whaleAddress: '0x000000000000000000000000000000000000beef',
    coin: 'BTC',
    side: 'B',
    px: '50000',
    sz: '0.1',
    whaleTs: 1700000000000,
    emittedAt: 1700000000001,
    ...over,
  };
}

/**
 * Fake Upstash Redis that returns one queued batch then nothing.
 * Tracks xack calls so we can verify each entry was acked.
 */
function fakeRedis(batch: { id: string; payload?: string }[]) {
  const acks: string[] = [];
  let served = false;
  const redis = {
    xgroup: vi.fn(async () => 'OK'),
    xack: vi.fn(async (_stream: string, _group: string, id: string) => {
      acks.push(id);
      return 1;
    }),
    xreadgroup: vi.fn(async () => {
      if (served) return null;
      served = true;
      return [
        [
          'mirror-intents',
          batch.map((b) => [b.id, b.payload !== undefined ? { payload: b.payload } : {}]),
        ],
      ];
    }),
  };
  return { redis, acks };
}

function engineDeps(decision: MirrorDecision): MirrorEngineDeps {
  // submitMirror only branches on `decision.kind`, so evaluateMirror is bypassed
  // entirely via a stub `assets` resolver. But the consumer calls evaluateMirror
  // on the parsed intent — we need a working pipeline. Use a real engine where
  // every lookup misses → skip(user_not_found). That's what `submitMirror`
  // turns into outcome.kind='skipped'.
  void decision;
  return {
    users: { byId: vi.fn(async () => undefined) },
    subscriptions: { forUserAndWhale: vi.fn(async () => undefined) },
    assets: { resolve: () => undefined },
    builderAddress: '0x000000000000000000000000000000000000aaaa',
  };
}

function submitDeps(outcomeKind: MirrorOutcome['kind'] = 'skipped'): SubmitMirrorDeps {
  return {
    risk: {
      accountEquity: { forUser: vi.fn(async () => undefined) },
      dailyNotional: { usedUsd: vi.fn(async () => 0) },
      geo: { countryFor: vi.fn(async () => undefined) },
      policy: {
        maxSlippageBps: 200,
        maxDailyNotionalUsd: 1_000_000,
        blockedCountries: [],
        requireKnownGeo: false,
      },
    },
    signer: { sign: vi.fn(async () => ({ r: '0x00', s: '0x00', v: 27 })) },
    transport: { exchange: vi.fn(async () => ({ status: 'ok', response: { type: 'order' } })) },
    notionalSink: { add: vi.fn(async () => undefined) },
    audit: { appendAudit: vi.fn(async () => undefined) },
    now: () => 1700000000000,
    nonce: () => 1,
    // unused — satisfies the type widening
    _outcomeKind: outcomeKind,
  } as unknown as SubmitMirrorDeps;
}

describe('runMirrorConsumer', () => {
  it('processes a batch and acks every entry', async () => {
    const { redis, acks } = fakeRedis([
      { id: '1-0', payload: JSON.stringify(intent()) },
      { id: '2-0', payload: JSON.stringify(intent({ idempotencyKey: 'fill-2:sub-1' })) },
    ]);
    const ctrl: ConsumerController = { stopped: false };
    const promise = runMirrorConsumer(
      {
        redis: redis as never,
        engineDeps: engineDeps({ kind: 'skip', reason: 'user_not_found' }),
        submitDeps: submitDeps(),
        log: makeLog(),
        consumerName: 'test-1',
        idleDelayMs: 1,
      },
      ctrl,
    );
    await new Promise((r) => setTimeout(r, 20));
    ctrl.stopped = true;
    await promise;
    expect(acks).toEqual(['1-0', '2-0']);
    expect(redis.xgroup).toHaveBeenCalledOnce();
  });

  it('acks even when the payload is missing', async () => {
    const { redis, acks } = fakeRedis([{ id: '3-0' }]);
    const ctrl: ConsumerController = { stopped: false };
    const log = makeLog();
    const promise = runMirrorConsumer(
      {
        redis: redis as never,
        engineDeps: engineDeps({ kind: 'skip', reason: 'invalid_intent' }),
        submitDeps: submitDeps(),
        log,
        consumerName: 'test-2',
        idleDelayMs: 1,
      },
      ctrl,
    );
    await new Promise((r) => setTimeout(r, 20));
    ctrl.stopped = true;
    await promise;
    expect(acks).toEqual(['3-0']);
  });

  it('acks even when JSON parse fails', async () => {
    const { redis, acks } = fakeRedis([{ id: '4-0', payload: 'not-json{' }]);
    const ctrl: ConsumerController = { stopped: false };
    const promise = runMirrorConsumer(
      {
        redis: redis as never,
        engineDeps: engineDeps({ kind: 'skip', reason: 'invalid_intent' }),
        submitDeps: submitDeps(),
        log: makeLog(),
        consumerName: 'test-3',
        idleDelayMs: 1,
      },
      ctrl,
    );
    await new Promise((r) => setTimeout(r, 20));
    ctrl.stopped = true;
    await promise;
    expect(acks).toEqual(['4-0']);
  });

  it('acks even when the intent fails zod validation', async () => {
    const { redis, acks } = fakeRedis([
      { id: '5-0', payload: JSON.stringify({ subscriberId: 'not-a-uuid' }) },
    ]);
    const ctrl: ConsumerController = { stopped: false };
    const promise = runMirrorConsumer(
      {
        redis: redis as never,
        engineDeps: engineDeps({ kind: 'skip', reason: 'invalid_intent' }),
        submitDeps: submitDeps(),
        log: makeLog(),
        consumerName: 'test-4',
        idleDelayMs: 1,
      },
      ctrl,
    );
    await new Promise((r) => setTimeout(r, 20));
    ctrl.stopped = true;
    await promise;
    expect(acks).toEqual(['5-0']);
  });
});
