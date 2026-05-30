import { describe, expect, it, vi } from 'vitest';
import { RedisProvisionalStore } from './redisProvisionalStore.js';
import type { Redis } from '@upstash/redis';
import type { ProvisionalRow } from '@whalepod/miniapp';

function fakeRow(id: string): ProvisionalRow {
  return {
    id,
    tgUserId: 12345n,
    tgUsername: 'alice',
    mainWallet: '0x1111111111111111111111111111111111111111',
    agentAddress: '0x2222222222222222222222222222222222222222',
    sealed: {
      ct: new Uint8Array([1, 2, 3]),
      iv: new Uint8Array(12).fill(7),
      tag: new Uint8Array(16).fill(9),
      dekCt: new Uint8Array([4, 5, 6]),
    },
    approvedMaxFeeTenthsBp: 50,
    currentFeeTenthsBp: 50,
    equityFloorUsd: '0',
    approveAgentAction: {
      type: 'approveAgent',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      agentAddress: '0x2222222222222222222222222222222222222222',
      agentName: 'WhalePod',
      nonce: 1,
    },
    approveBuilderFeeAction: {
      type: 'approveBuilderFee',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      maxFeeRate: '0.0500%',
      builder: '0x3333333333333333333333333333333333333333',
      nonce: 2,
    },
  };
}

function makeFakeRedis(): { redis: Redis; storage: Map<string, unknown>; calls: string[] } {
  const storage = new Map<string, unknown>();
  const calls: string[] = [];
  const redis = {
    set: vi.fn((key: string, value: unknown, opts?: { ex?: number }) => {
      calls.push(`set ${key} ex=${String(opts?.ex ?? 'none')}`);
      storage.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => {
      calls.push(`get ${key}`);
      return Promise.resolve(storage.get(key) ?? null);
    }),
    del: vi.fn((key: string) => {
      calls.push(`del ${key}`);
      const had = storage.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),
  } as unknown as Redis;
  return { redis, storage, calls };
}

describe('RedisProvisionalStore', () => {
  it('round-trips a ProvisionalRow including bigint and Uint8Array fields', async () => {
    const { redis } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis });
    const original = fakeRow('p-001');
    await store.put(original);
    const fetched = await store.get('p-001');
    expect(fetched).not.toBeNull();
    expect(fetched?.tgUserId).toBe(12345n);
    expect(fetched?.sealed.ct).toEqual(original.sealed.ct);
    expect(fetched?.sealed.iv).toEqual(original.sealed.iv);
    expect(fetched?.sealed.tag).toEqual(original.sealed.tag);
    expect(fetched?.sealed.dekCt).toEqual(original.sealed.dekCt);
    expect(fetched?.mainWallet).toBe(original.mainWallet);
  });

  it('sets a TTL on put (default 15 min)', async () => {
    const { redis, calls } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis });
    await store.put(fakeRow('p-002'));
    expect(calls[0]).toBe('set prov:p-002 ex=900');
  });

  it('honors a custom TTL', async () => {
    const { redis, calls } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis, ttlSeconds: 60 });
    await store.put(fakeRow('p-003'));
    expect(calls[0]).toBe('set prov:p-003 ex=60');
  });

  it('get returns null when missing', async () => {
    const { redis } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis });
    expect(await store.get('nope')).toBeNull();
  });

  it('delete removes the key', async () => {
    const { redis, storage } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis });
    await store.put(fakeRow('p-004'));
    await store.delete('p-004');
    expect(storage.has('prov:p-004')).toBe(false);
  });

  it('keys are prefixed with "prov:" to avoid collisions', async () => {
    const { redis, storage } = makeFakeRedis();
    const store = new RedisProvisionalStore({ redis });
    await store.put(fakeRow('p-005'));
    expect([...storage.keys()][0]).toBe('prov:p-005');
  });
});
