import { describe, expect, it, vi } from 'vitest';
import type { HttpHlTransport } from '@whalepod/sdk';
import { MarkPriceCache } from './markPriceCache.js';

interface FakeTransport {
  info: <T>(query: Record<string, unknown>) => Promise<T>;
}

function makeTransport(map: Record<string, string>): FakeTransport {
  return {
    info: vi.fn(() => Promise.resolve(map)) as unknown as <T>(
      q: Record<string, unknown>,
    ) => Promise<T>,
  };
}

describe('MarkPriceCache', () => {
  it('returns null before first refresh', () => {
    const t = makeTransport({ ETH: '3000' });
    const cache = new MarkPriceCache({
      transport: t as unknown as HttpHlTransport,
      refreshMs: 60_000,
    });
    expect(cache.get()('ETH')).toBeNull();
  });

  it('serves prices after refresh, case-insensitive', async () => {
    const t = makeTransport({ ETH: '3000', btc: '60000' });
    const cache = new MarkPriceCache({
      transport: t as unknown as HttpHlTransport,
      refreshMs: 60_000,
    });
    await cache.refresh();
    expect(cache.get()('ETH')).toBe('3000');
    expect(cache.get()('eth')).toBe('3000');
    expect(cache.get()('BTC')).toBe('60000');
    expect(cache.get()('SOL')).toBeNull();
  });

  it('replaces the price set on each refresh (no stale residue)', async () => {
    let payload: Record<string, string> = { ETH: '3000', SOL: '150' };
    const transport: FakeTransport = {
      info: vi.fn(() => Promise.resolve(payload)) as unknown as <T>(
        q: Record<string, unknown>,
      ) => Promise<T>,
    };
    const cache = new MarkPriceCache({
      transport: transport as unknown as HttpHlTransport,
      refreshMs: 60_000,
    });
    await cache.refresh();
    expect(cache.get()('SOL')).toBe('150');
    payload = { ETH: '3100' };
    await cache.refresh();
    expect(cache.get()('ETH')).toBe('3100');
    expect(cache.get()('SOL')).toBeNull();
  });
});
