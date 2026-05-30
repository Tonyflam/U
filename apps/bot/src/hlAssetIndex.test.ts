/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { DrizzleSubscriptionSnapshotLookup, DrizzleUserSnapshotLookup } from './mirrorSnapshots.js';
import { HlAssetIndex } from './hlAssetIndex.js';

describe('snapshot lookups (smoke)', () => {
  it('DrizzleUserSnapshotLookup exposes byId', () => {
    const proto = DrizzleUserSnapshotLookup.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['byId']).toBe('function');
  });

  it('DrizzleSubscriptionSnapshotLookup exposes forUserAndWhale', () => {
    const proto = DrizzleSubscriptionSnapshotLookup.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['forUserAndWhale']).toBe('function');
  });
});

describe('HlAssetIndex', () => {
  it('returns undefined before refresh', () => {
    const idx = new HlAssetIndex({ info: vi.fn() });
    expect(idx.resolve('BTC')).toBeUndefined();
    expect(idx.size()).toBe(0);
    expect(idx.lastRefresh()).toBe(0);
  });

  it('populates the map from HL meta and resolves by uppercase ticker', async () => {
    const info = vi.fn(async () => ({
      universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }],
    }));
    const idx = new HlAssetIndex(
      { info: info as unknown as <T = unknown>(q: Record<string, unknown>) => Promise<T> },
      { now: () => 1234 },
    );
    await idx.refresh();
    expect(idx.resolve('BTC')).toBe(0);
    expect(idx.resolve('eth')).toBe(1);
    expect(idx.resolve('SOL')).toBe(2);
    expect(idx.resolve('DOGE')).toBeUndefined();
    expect(idx.size()).toBe(3);
    expect(idx.lastRefresh()).toBe(1234);
    expect(info).toHaveBeenCalledWith({ type: 'meta' });
  });

  it('overwrites the previous map on refresh', async () => {
    let universe: { name: string }[] = [{ name: 'BTC' }];
    const info = vi.fn(async () => ({ universe }));
    const idx = new HlAssetIndex({
      info: info as unknown as <T = unknown>(q: Record<string, unknown>) => Promise<T>,
    });
    await idx.refresh();
    expect(idx.resolve('BTC')).toBe(0);
    universe = [{ name: 'ETH' }];
    await idx.refresh();
    expect(idx.resolve('BTC')).toBeUndefined();
    expect(idx.resolve('ETH')).toBe(0);
  });
});
