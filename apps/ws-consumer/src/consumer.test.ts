import { describe, expect, it } from 'vitest';
import { InMemoryIntentSink } from './sink.js';
import { InMemoryWatchAlertSink } from './watchSink.js';
import {
  runConsumer,
  type FillSource,
  type SubscriberLookup,
  type WatcherLookup,
} from './consumer.js';
import type { Subscriber } from './fanout.js';

const WHALE = '0x1111222233334444555566667777888899990000';
const u1 = '11111111-1111-1111-1111-111111111111';
const u2 = '22222222-2222-2222-2222-222222222222';

const noop = (): void => undefined;
const silentLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

function arraySource(events: readonly unknown[]): FillSource {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator yields synchronously here for test determinism.
    async *events() {
      for (const e of events) yield e;
    },
  };
}

function staticLookup(map: Record<string, readonly Subscriber[]>): SubscriberLookup {
  return {
    subscribersFor(addr) {
      return Promise.resolve(map[addr] ?? []);
    },
  };
}

const validEvent = (hash: string) => ({
  hash,
  oid: Number.parseInt(hash.replace(/\D/g, '') || '0', 10),
  user: WHALE,
  coin: 'BTC',
  side: 'B',
  px: '50000',
  sz: '0.1',
  time: 1_700_000_000_000,
});

describe('runConsumer', () => {
  it('happy path: emits one intent per event per eligible subscriber', async () => {
    const sink = new InMemoryIntentSink();
    const stats = await runConsumer({
      source: arraySource([validEvent('f1'), validEvent('f2')]),
      subscribers: staticLookup({
        [WHALE]: [
          { id: u1, whaleAddress: WHALE, paused: false, killSwitch: false },
          { id: u2, whaleAddress: WHALE, paused: false, killSwitch: false },
        ],
      }),
      sink,
      logger: silentLogger,
      now: () => 1_700_000_000_100,
    });
    expect(stats.processed).toBe(2);
    expect(stats.emitted).toBe(4);
    expect(stats.dedupedAtSink).toBe(0);
    expect(stats.invalid).toBe(0);
    expect(sink.recorded).toHaveLength(4);
  });

  it('skips invalid upstream payloads without crashing', async () => {
    const sink = new InMemoryIntentSink();
    const stats = await runConsumer({
      source: arraySource([{ not: 'a fill' }, validEvent('f1'), null]),
      subscribers: staticLookup({
        [WHALE]: [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }],
      }),
      sink,
      logger: silentLogger,
    });
    expect(stats.invalid).toBe(2);
    expect(stats.processed).toBe(1);
    expect(stats.emitted).toBe(1);
  });

  it('dedupes when the same idempotency key is replayed', async () => {
    const sink = new InMemoryIntentSink();
    const stats = await runConsumer({
      source: arraySource([validEvent('replay'), validEvent('replay')]),
      subscribers: staticLookup({
        [WHALE]: [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }],
      }),
      sink,
      logger: silentLogger,
    });
    expect(stats.processed).toBe(2);
    expect(stats.emitted).toBe(1);
    expect(stats.dedupedAtSink).toBe(1);
    expect(sink.recorded).toHaveLength(1);
  });

  it('continues processing when subscriber lookup throws for one event', async () => {
    const sink = new InMemoryIntentSink();
    let calls = 0;
    const lookup: SubscriberLookup = {
      subscribersFor: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('db down'));
        return Promise.resolve([{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }]);
      },
    };
    const stats = await runConsumer({
      source: arraySource([validEvent('f1'), validEvent('f2')]),
      subscribers: lookup,
      sink,
      logger: silentLogger,
    });
    expect(stats.processed).toBe(2);
    expect(stats.emitted).toBe(1);
  });

  it('continues processing when sink throws for one intent', async () => {
    let emitCalls = 0;
    const sink = {
      emit(): Promise<boolean> {
        emitCalls += 1;
        if (emitCalls === 1) return Promise.reject(new Error('redis flap'));
        return Promise.resolve(true);
      },
    };
    const stats = await runConsumer({
      source: arraySource([validEvent('f1'), validEvent('f2')]),
      subscribers: staticLookup({
        [WHALE]: [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }],
      }),
      sink,
      logger: silentLogger,
    });
    expect(stats.processed).toBe(2);
    expect(stats.emitted).toBe(1);
  });

  it('fans out watch alerts to every watcher with the whale alias', async () => {
    const sink = new InMemoryIntentSink();
    const watchSink = new InMemoryWatchAlertSink();
    const watchers: WatcherLookup = {
      watchersFor: (addr) =>
        Promise.resolve(
          addr === WHALE
            ? { tgUserIds: ['111', '222'], whaleAlias: 'HYPE-Maxi' }
            : { tgUserIds: [], whaleAlias: null },
        ),
    };
    const stats = await runConsumer({
      source: arraySource([validEvent('f1')]),
      subscribers: staticLookup({}),
      sink,
      watchers,
      watchSink,
      logger: silentLogger,
    });
    expect(stats.processed).toBe(1);
    expect(watchSink.recorded).toHaveLength(2);
    expect(watchSink.recorded.map((r) => r.tgUserId)).toStrictEqual(['111', '222']);
    expect(watchSink.recorded[0]?.event).toMatchObject({
      fillHash: 'f1',
      whaleAddress: WHALE,
      whaleAlias: 'HYPE-Maxi',
      coin: 'BTC',
      side: 'B',
    });
  });

  it('dedupes watch alerts per (fill, watcher) on replay', async () => {
    const watchSink = new InMemoryWatchAlertSink();
    await runConsumer({
      source: arraySource([validEvent('replay'), validEvent('replay')]),
      subscribers: staticLookup({}),
      sink: new InMemoryIntentSink(),
      watchers: {
        watchersFor: () => Promise.resolve({ tgUserIds: ['111'], whaleAlias: null }),
      },
      watchSink,
      logger: silentLogger,
    });
    expect(watchSink.recorded).toHaveLength(1);
  });

  it('watcher lookup or watch sink failures never break the mirror path', async () => {
    const sink = new InMemoryIntentSink();
    const stats = await runConsumer({
      source: arraySource([validEvent('f1'), validEvent('f2')]),
      subscribers: staticLookup({
        [WHALE]: [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }],
      }),
      sink,
      watchers: {
        watchersFor: () => Promise.reject(new Error('db down')),
      },
      watchSink: new InMemoryWatchAlertSink(),
      logger: silentLogger,
    });
    expect(stats.processed).toBe(2);
    expect(stats.emitted).toBe(2);

    const flakySink = {
      emit: (): Promise<boolean> => Promise.reject(new Error('redis flap')),
    };
    const stats2 = await runConsumer({
      source: arraySource([validEvent('f3')]),
      subscribers: staticLookup({
        [WHALE]: [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }],
      }),
      sink,
      watchers: {
        watchersFor: () => Promise.resolve({ tgUserIds: ['111'], whaleAlias: null }),
      },
      watchSink: flakySink,
      logger: silentLogger,
    });
    expect(stats2.emitted).toBe(1);
  });
});
