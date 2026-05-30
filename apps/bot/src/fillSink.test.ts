import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { AnyDb } from '@whalepod/schema';
import { DrizzleFillSink, type MirrorFillRow } from './fillSink.js';

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const ROW: MirrorFillRow = {
  hlFillId: '0xcloid1',
  whaleAddress: '0xabcd000000000000000000000000000000000001',
  coin: 'ETH',
  side: 'B',
  px: '3000',
  sz: '0.5',
  notionalUsd: '1500.00',
  builderFeeTenthsBp: 50,
  builderFeeUsd: '0.750000',
  userId: 'u-1',
  ts: 1_700_000_000_000,
};

interface FakeDb {
  values: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
  db: AnyDb;
}

function fakeDb(opts: { throwOnInsert?: boolean } = {}): FakeDb {
  const onConflictDoNothing = vi.fn(() =>
    opts.throwOnInsert ? Promise.reject(new Error('db down')) : Promise.resolve(undefined),
  );
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { values, onConflictDoNothing, db: { insert } as unknown as AnyDb };
}

describe('DrizzleFillSink', () => {
  it('inserts a mirror fill with whaleAddress in wallet column', async () => {
    const { values, db } = fakeDb();
    const sink = new DrizzleFillSink({ db, log });
    await sink.recordMirrorFill(ROW);
    expect(values).toHaveBeenCalledTimes(1);
    const arg = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['wallet']).toBe(ROW.whaleAddress);
    expect(arg['isMirror']).toBe(true);
    expect(arg['userId']).toBe('u-1');
    expect(arg['hlFillId']).toBe('0xcloid1');
    expect(arg['ts']).toBeInstanceOf(Date);
  });

  it('uses onConflictDoNothing for idempotent re-inserts', async () => {
    const { onConflictDoNothing, db } = fakeDb();
    const sink = new DrizzleFillSink({ db, log });
    await sink.recordMirrorFill(ROW);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('swallows insert errors so submit path is unaffected', async () => {
    const { db } = fakeDb({ throwOnInsert: true });
    const sink = new DrizzleFillSink({ db, log });
    await expect(sink.recordMirrorFill(ROW)).resolves.toBeUndefined();
  });
});
