import { describe, expect, it, vi } from 'vitest';
import type { HttpHlTransport } from '@whalepod/sdk';
import { pickBaseUrl, probeAllMids, probeMarkPriceCache, probeMeta, runSmoke } from './smoke.js';

function fakeTransport(map: Record<string, unknown>): HttpHlTransport {
  return {
    info: vi.fn((q: Record<string, unknown>) => {
      const key = String(q['type']);
      if (!(key in map)) return Promise.reject(new Error(`unmocked: ${key}`));
      return Promise.resolve(map[key]);
    }) as unknown as HttpHlTransport['info'],
  } as unknown as HttpHlTransport;
}

describe('pickBaseUrl', () => {
  it('honours HL_API_URL when set', () => {
    expect(pickBaseUrl({ HL_API_URL: 'https://example.test' })).toBe('https://example.test');
  });

  it('defaults to testnet when HL_NETWORK is unset', () => {
    expect(pickBaseUrl({})).toContain('testnet');
  });

  it('selects mainnet when HL_NETWORK=mainnet', () => {
    expect(pickBaseUrl({ HL_NETWORK: 'mainnet' })).not.toContain('testnet');
  });
});

describe('smoke probes', () => {
  it('probeMeta returns universe length', async () => {
    const t = fakeTransport({ meta: { universe: [{ name: 'BTC' }, { name: 'ETH' }] } });
    expect(await probeMeta(t)).toBe(2);
  });

  it('probeMeta throws on empty universe', async () => {
    const t = fakeTransport({ meta: { universe: [] } });
    await expect(probeMeta(t)).rejects.toThrow(/empty/);
  });

  it('probeAllMids requires at least one probe coin', async () => {
    const good = fakeTransport({ allMids: { BTC: '60000', FOO: '1' } });
    expect(await probeAllMids(good)).toBe(2);
    const bad = fakeTransport({ allMids: { FOO: '1' } });
    await expect(probeAllMids(bad)).rejects.toThrow(/probe coins/);
  });

  it('probeMarkPriceCache hydrates and resolves a probe coin', async () => {
    const t = fakeTransport({ allMids: { ETH: '3000' } });
    await expect(probeMarkPriceCache(t)).resolves.toBeUndefined();
  });

  it('runSmoke chains all probes and writes PASS', async () => {
    const lines: string[] = [];
    const io = { out: (m: string) => lines.push(m), err: (m: string) => lines.push(m) };
    const t = fakeTransport({
      meta: { universe: [{ name: 'BTC' }] },
      allMids: { BTC: '60000', ETH: '3000' },
    });
    await runSmoke(io, t);
    expect(lines.join('')).toMatch(/PASS/);
  });
});
