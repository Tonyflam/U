/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { HlInfoEquity, type UserAddressLookup } from './hlInfoEquity.js';
import type { HttpHlTransport } from '@whalepod/sdk';

const ADDR = '0x000000000000000000000000000000000000abcd';

function makeTransport(impl: (q: unknown) => Promise<unknown>): Pick<HttpHlTransport, 'info'> {
  return { info: impl as unknown as HttpHlTransport['info'] };
}

const addresses: UserAddressLookup = {
  mainWalletFor: async (id) => (id === 'unknown' ? undefined : ADDR),
};

describe('HlInfoEquity', () => {
  it('returns parsed equity + withdrawable', async () => {
    const fn = vi.fn(async () => ({
      marginSummary: { accountValue: '12345.5' },
      withdrawable: '999.25',
    }));
    const eq = new HlInfoEquity({ transport: makeTransport(fn), addresses });
    const out = await eq.forUser('u1');
    expect(out).toEqual({ equityUsd: 12345.5, withdrawableUsd: 999.25 });
    expect(fn).toHaveBeenCalledWith({ type: 'clearinghouseState', user: ADDR });
  });

  it('returns undefined when the user has no mainWallet', async () => {
    const fn = vi.fn(async () => ({ marginSummary: { accountValue: '1' } }));
    const eq = new HlInfoEquity({ transport: makeTransport(fn), addresses });
    const out = await eq.forUser('unknown');
    expect(out).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns undefined when info throws', async () => {
    const eq = new HlInfoEquity({
      transport: makeTransport(async () => {
        throw new Error('boom');
      }),
      addresses,
    });
    expect(await eq.forUser('u1')).toBeUndefined();
  });

  it('returns undefined on malformed accountValue', async () => {
    const eq = new HlInfoEquity({
      transport: makeTransport(async () => ({ marginSummary: { accountValue: 'NaN' } })),
      addresses,
    });
    expect(await eq.forUser('u1')).toBeUndefined();
  });

  it('treats missing withdrawable as 0', async () => {
    const eq = new HlInfoEquity({
      transport: makeTransport(async () => ({ marginSummary: { accountValue: '10' } })),
      addresses,
    });
    expect(await eq.forUser('u1')).toEqual({ equityUsd: 10, withdrawableUsd: 0 });
  });

  it('caches for cacheTtlMs and refetches after expiry', async () => {
    let calls = 0;
    let t = 0;
    const eq = new HlInfoEquity({
      transport: makeTransport(async () => {
        calls += 1;
        return { marginSummary: { accountValue: String(calls) } };
      }),
      addresses,
      cacheTtlMs: 1_000,
      now: () => t,
    });
    await eq.forUser('u1');
    await eq.forUser('u1');
    expect(calls).toBe(1);
    t = 2_000;
    await eq.forUser('u1');
    expect(calls).toBe(2);
  });
});
