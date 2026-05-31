import { describe, expect, it, vi } from 'vitest';
import { HlExchangeError } from '@whalepod/sdk';
import { closePositions, type PositionCloserDeps } from './positionCloser.js';
import type { LivePositionsLookup } from './hlLivePositions.js';

const USER = {
  id: 'user-1',
  mainWallet: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  agentAddress: '0x2222222222222222222222222222222222222222' as `0x${string}`,
  currentFeeTenthsBp: 5,
  approvedMaxFeeTenthsBp: 10,
} as const;

const BUILDER = '0x3333333333333333333333333333333333333333' as `0x${string}`;

function makeDeps(
  overrides: Partial<PositionCloserDeps> & { positions: LivePositionsLookup },
): PositionCloserDeps {
  let nonce = 1700000000000;
  return {
    assets: { resolve: (coin: string) => (coin === 'ETH' ? 4 : coin === 'BTC' ? 0 : undefined) },
    markPrice: (coin: string) => (coin === 'ETH' ? '2000' : coin === 'BTC' ? '60000' : null),
    signer: {
      sign: vi.fn().mockResolvedValue({ r: '0xaa', s: '0xbb', v: 27 } as never),
    },
    transport: { exchange: vi.fn().mockResolvedValue({ status: 'ok' } as never) },
    audit: { appendAudit: vi.fn().mockResolvedValue(undefined) },
    builderAddress: BUILDER,
    nonce: () => ++nonce,
    now: () => 1700000000000,
    ...overrides,
  };
}

describe('closePositions', () => {
  it('returns no_positions when HL has no open positions', async () => {
    const deps = makeDeps({ positions: { forUser: async () => [] } });
    const out = await closePositions(USER, null, deps);
    expect(out).toStrictEqual({ kind: 'no_positions' });
  });

  it('returns coin_not_open when /close <coin> targets a coin the user has no exposure to', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [{ coin: 'BTC', szi: 0.1, entryPx: 60000, unrealizedPnlUsd: 0 }],
      },
    });
    const out = await closePositions(USER, 'ETH', deps);
    expect(out).toStrictEqual({ kind: 'coin_not_open', coin: 'ETH' });
  });

  it('builds a reduce-only BUY to close a short (szi < 0)', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [{ coin: 'ETH', szi: -0.085, entryPx: 1997.78, unrealizedPnlUsd: -0.5 }],
      },
    });
    const out = await closePositions(USER, 'ETH', deps);
    expect(out.kind).toBe('closed');
    if (out.kind !== 'closed') throw new Error();
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ coin: 'ETH', kind: 'submitted', sz: '0.085', isBuy: true });

    const exchange = deps.transport.exchange as ReturnType<typeof vi.fn>;
    expect(exchange).toHaveBeenCalledTimes(1);
    const action = exchange.mock.calls[0]?.[0].action as { orders: Array<{ r: boolean; b: boolean; s: string; t: { limit: { tif: string } } }> };
    expect(action.orders[0]?.r).toBe(true);
    expect(action.orders[0]?.b).toBe(true);
    expect(action.orders[0]?.s).toBe('0.085');
    expect(action.orders[0]?.t.limit.tif).toBe('Ioc');
  });

  it('builds a reduce-only SELL to close a long (szi > 0)', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [{ coin: 'BTC', szi: 0.0125, entryPx: 60000, unrealizedPnlUsd: 1 }],
      },
    });
    const out = await closePositions(USER, null, deps);
    expect(out.kind).toBe('closed');
    if (out.kind !== 'closed') throw new Error();
    expect(out.results[0]).toMatchObject({ coin: 'BTC', kind: 'submitted', sz: '0.0125', isBuy: false });
  });

  it('skips coins with no mark price', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [{ coin: 'ETH', szi: 1, entryPx: 2000, unrealizedPnlUsd: 0 }],
      },
      markPrice: () => null,
    });
    const out = await closePositions(USER, null, deps);
    expect(out).toMatchObject({ kind: 'closed', results: [{ coin: 'ETH', kind: 'no_mark' }] });
    expect(deps.transport.exchange).not.toHaveBeenCalled();
  });

  it('reports exchange errors per-coin and continues with the rest', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [
          { coin: 'ETH', szi: -1, entryPx: 2000, unrealizedPnlUsd: 0 },
          { coin: 'BTC', szi: 0.1, entryPx: 60000, unrealizedPnlUsd: 0 },
        ],
      },
    });
    let call = 0;
    deps.transport.exchange = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) throw new HlExchangeError({ status: 'err', response: 'Order would not reduce position' });
      return { status: 'ok' };
    }) as never;
    const out = await closePositions(USER, null, deps);
    expect(out.kind).toBe('closed');
    if (out.kind !== 'closed') throw new Error();
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ coin: 'ETH', kind: 'exchange_error' });
    expect(out.results[1]).toMatchObject({ coin: 'BTC', kind: 'submitted' });
  });

  it('audits both success and failure', async () => {
    const deps = makeDeps({
      positions: {
        forUser: async () => [{ coin: 'ETH', szi: -1, entryPx: 2000, unrealizedPnlUsd: 0 }],
      },
    });
    await closePositions(USER, null, deps);
    expect(deps.audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'op:user-1', action: 'position.close', target: 'coin:ETH' }),
    );
  });
});
