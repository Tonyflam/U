/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { HlExchangeError, HlTransportError, type HlSignature } from '@whalepod/sdk';
import { submitMirror, type SubmitMirrorDeps } from './submitMirror.js';
import type { MirrorDecision } from './mirrorEngine.js';
import type { RiskDeps } from './riskEngine.js';

const ADDR = '0x000000000000000000000000000000000000beef';
const AGENT = '0x000000000000000000000000000000000000a9ea';
const WHALE = '0x000000000000000000000000000000000000abcd';

const SIG: HlSignature = {
  r: `0x${'1'.repeat(64)}`,
  s: `0x${'2'.repeat(64)}`,
  v: 27,
};

function submitDecision(
  over: Partial<{ mirrorSizeUsd: number; limitPx: string }> = {},
): MirrorDecision {
  return {
    kind: 'submit',
    user: {
      id: 'user-1',
      killSwitch: false,
      revoked: false,
      agentAddress: AGENT,
      approvedMaxFeeTenthsBp: 50,
      currentFeeTenthsBp: 50,
      equityFloorUsd: '100',
    },
    subscription: {
      id: 'sub-1',
      userId: 'user-1',
      whaleAddress: WHALE,
      paused: false,
      maxSizeUsd: '1000',
      maxLeverage: 5,
      allowedCoins: null,
    },
    action: {
      type: 'order',
      orders: [
        {
          a: 0,
          b: true,
          p: over.limitPx ?? '100',
          s: '10',
          r: false,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
      builder: { b: ADDR, f: 50 },
    },
    orderIntent: {
      asset: 0,
      isBuy: true,
      limitPx: over.limitPx ?? '100',
      sz: '10',
      reduceOnly: false,
      tif: 'Ioc',
    },
    coin: 'BTC',
    mirrorSizeUsd: over.mirrorSizeUsd ?? 1_000,
    feeTenthsBp: 50,
    cloid: '0xdeadbeefdeadbeefdeadbeefdeadbeef',
  };
}

function makeRisk(over: { country?: string; equityUsd?: number; usedUsd?: number } = {}): RiskDeps {
  return {
    accountEquity: {
      forUser: async () => ({ equityUsd: over.equityUsd ?? 50_000, withdrawableUsd: 50_000 }),
    },
    dailyNotional: { usedUsd: async () => over.usedUsd ?? 0 },
    geo: { countryFor: async () => over.country ?? 'CA' },
    policy: {
      maxSlippageBps: 100,
      maxDailyNotionalUsd: 100_000,
      blockedCountries: ['US'],
      requireKnownGeo: false,
    },
  };
}

function makeDeps(
  opts: {
    risk?: RiskDeps;
    exchange?: SubmitMirrorDeps['transport']['exchange'];
    sign?: SubmitMirrorDeps['signer']['sign'];
  } = {},
): {
  deps: SubmitMirrorDeps;
  audit: ReturnType<typeof vi.fn>;
  notional: ReturnType<typeof vi.fn>;
} {
  const audit = vi.fn(async () => undefined);
  const notional = vi.fn(async () => undefined);
  const deps: SubmitMirrorDeps = {
    risk: opts.risk ?? makeRisk(),
    signer: { sign: opts.sign ?? (async () => SIG) },
    transport: {
      exchange:
        opts.exchange ??
        (async () => ({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } },
        })),
    },
    notionalSink: { add: notional as unknown as SubmitMirrorDeps['notionalSink']['add'] },
    audit: { appendAudit: audit as unknown as SubmitMirrorDeps['audit']['appendAudit'] },
    now: () => 1_700_000_000_000,
    nonce: () => 1_700_000_000_001,
  };
  return { deps, audit, notional };
}

describe('submitMirror', () => {
  it('returns skipped for a skip decision and writes no audit', async () => {
    const { deps, audit } = makeDeps();
    const out = await submitMirror({ kind: 'skip', reason: 'global_kill' }, deps);
    expect(out).toEqual({ kind: 'skipped', reason: 'global_kill' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('signs, submits, increments notional, and audits on happy path', async () => {
    const { deps, audit, notional } = makeDeps();
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('submitted');
    expect(notional).toHaveBeenCalledWith('user-1', 1_000, 1_700_000_000_000);
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as {
      actor: string;
      action: string;
      after: { outcome: string };
    };
    expect(entry.actor).toBe('op:user-1');
    expect(entry.action).toBe('mirror.submit');
    expect(entry.after.outcome).toBe('submitted');
  });

  it('blocks on risk and does not call signer/transport/notional', async () => {
    const sign = vi.fn(async () => SIG);
    const exchange = vi.fn(async () => ({ status: 'ok' as const, response: { type: 'order' } }));
    const { deps, audit, notional } = makeDeps({
      risk: makeRisk({ country: 'US' }),
      sign,
      exchange,
    });
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('risk_blocked');
    if (out.kind === 'risk_blocked') expect(out.reason).toBe('geo_blocked');
    expect(sign).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(notional).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('audits transport_error and does not increment notional when signer throws', async () => {
    const { deps, audit, notional } = makeDeps({
      sign: async () => {
        throw new Error('kms boom');
      },
    });
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('transport_error');
    if (out.kind === 'transport_error') expect(out.message).toBe('kms boom');
    expect(notional).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as { after: { outcome: string; stage: string } };
    expect(entry.after.outcome).toBe('transport_error');
    expect(entry.after.stage).toBe('sign');
  });

  it('maps HlExchangeError to exchange_error and does not increment notional', async () => {
    const { deps, audit, notional } = makeDeps({
      exchange: async () => {
        throw new HlExchangeError({ status: 'err', response: 'insufficient margin' });
      },
    });
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('exchange_error');
    if (out.kind === 'exchange_error') expect(out.message).toBe('insufficient margin');
    expect(notional).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as { after: { outcome: string; message: string } };
    expect(entry.after.outcome).toBe('exchange_error');
  });

  it('treats per-order error inside status:ok envelope as exchange_error', async () => {
    const { deps, audit, notional } = makeDeps({
      exchange: async () => ({
        status: 'ok' as const,
        response: {
          type: 'order',
          data: { statuses: [{ error: 'Order has insufficient margin to open.' }] },
        },
      }),
    });
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('exchange_error');
    if (out.kind === 'exchange_error') {
      expect(out.message).toContain('insufficient margin');
    }
    expect(notional).not.toHaveBeenCalled();
    const entry = audit.mock.calls[0]?.[0] as { after: { outcome: string } };
    expect(entry.after.outcome).toBe('exchange_error');
  });

  it('maps HlTransportError to transport_error with stage=exchange', async () => {
    const { deps, audit, notional } = makeDeps({
      exchange: async () => {
        throw new HlTransportError('timeout');
      },
    });
    const out = await submitMirror(submitDecision(), deps);
    expect(out.kind).toBe('transport_error');
    expect(notional).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0] as { after: { outcome: string; stage: string } };
    expect(entry.after.stage).toBe('exchange');
  });

  it('passes a monotonic nonce to both signer and transport', async () => {
    const sign = vi.fn<SubmitMirrorDeps['signer']['sign']>(async () => SIG);
    const exchange = vi.fn<SubmitMirrorDeps['transport']['exchange']>(async () => ({
      status: 'ok' as const,
      response: { type: 'order' },
    }));
    const { deps } = makeDeps({ sign, exchange });
    await submitMirror(submitDecision(), deps);
    const signNonce = sign.mock.calls[0]?.[0].nonce;
    const exchangeNonce = exchange.mock.calls[0]?.[0].nonce;
    expect(signNonce).toBe(exchangeNonce);
    expect(signNonce).toBe(1_700_000_000_001);
  });
});
