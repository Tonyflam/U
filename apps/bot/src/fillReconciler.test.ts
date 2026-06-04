import { describe, expect, it, vi } from 'vitest';
import { FillReconciler } from './fillReconciler.js';

function makeDb(rows: { hlFillId: string; userId: string; mainWallet: string }[]): {
  db: unknown;
  updates: { hlFillId: string; patch: Record<string, unknown> }[];
} {
  const updates: { hlFillId: string; patch: Record<string, unknown> }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (whereExpr: { _whereCloid?: string }) =>
          Promise.resolve(updates.push({ hlFillId: whereExpr._whereCloid ?? '?', patch })),
      }),
    }),
  };
  return { db, updates };
}

describe('FillReconciler', () => {
  it('skips users with no HL match for any pending cloid', async () => {
    const { db } = makeDb([{ hlFillId: '0xabc', userId: 'u1', mainWallet: '0xwallet1' }]);
    const transport = {
      info: vi.fn().mockResolvedValue([{ cloid: '0xother', px: 100, sz: 1 }]),
    };
    const r = new FillReconciler({
      db: db as never,
      transport,
      log: { warn: vi.fn(), info: vi.fn() } as never,
    });
    const res = await r.reconcileOnce();
    expect(res.users).toBe(1);
    expect(res.reconciled).toBe(0);
  });

  it('tick is no-op if previous tick still running', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const transport = {
      info: vi.fn().mockImplementation(async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        return [];
      }),
    };
    const r = new FillReconciler({
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([{ hlFillId: '0xa', userId: 'u', mainWallet: '0xw' }]),
            }),
          }),
        }),
      } as never,
      transport,
      log: { warn: vi.fn(), info: vi.fn() } as never,
    });
    await Promise.all([r.tick(), r.tick(), r.tick()]);
    expect(maxInflight).toBeLessThanOrEqual(1);
  });
});
