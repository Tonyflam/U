import { describe, expect, it } from 'vitest';
import { Address } from '@whalepod/schema';
import {
  evaluateMirror,
  type AssetIndexResolver,
  type MirrorEngineDeps,
  type SubscriptionSnapshot,
  type UserSnapshot,
} from './mirrorEngine.js';

const BUILDER: Address = Address.parse('0x' + 'b'.repeat(40));
const WHALE: Address = Address.parse('0x' + 'a'.repeat(40));
const AGENT: Address = Address.parse('0x' + 'c'.repeat(40));
const USER_ID = '11111111-1111-1111-1111-111111111111';
const SUB_ID = '22222222-2222-2222-2222-222222222222';

function user(over: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    id: USER_ID,
    killSwitch: false,
    revoked: false,
    agentAddress: AGENT,
    approvedMaxFeeTenthsBp: 50,
    currentFeeTenthsBp: 30,
    equityFloorUsd: '0',
    ...over,
  };
}

function sub(over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: SUB_ID,
    userId: USER_ID,
    whaleAddress: WHALE,
    paused: false,
    maxSizeUsd: '100.00',
    maxLeverage: 3,
    allowedCoins: null,
    tpBps: null,
    slBps: null,
    ...over,
  };
}

function makeAssets(map: Record<string, number>): AssetIndexResolver {
  return {
    resolve(coin) {
      return Object.prototype.hasOwnProperty.call(map, coin) ? map[coin] : undefined;
    },
    szDecimals() {
      return 4;
    },
  };
}

function makeDeps(
  over: {
    user?: UserSnapshot | undefined;
    sub?: SubscriptionSnapshot | undefined;
    assets?: Record<string, number>;
    globalKill?: boolean;
    builder?: Address;
  } = {},
): MirrorEngineDeps {
  const deps: MirrorEngineDeps = {
    users: { byId: () => Promise.resolve(over.user) },
    subscriptions: { forUserAndWhale: () => Promise.resolve(over.sub) },
    assets: makeAssets(over.assets ?? { BTC: 0, ETH: 1 }),
    builderAddress: over.builder ?? BUILDER,
  };
  if (over.globalKill !== undefined) return { ...deps, globalKill: over.globalKill };
  return deps;
}

function intent(over: Record<string, unknown> = {}): unknown {
  return {
    idempotencyKey: 'h1:sub1',
    subscriberId: USER_ID,
    whaleFillId: 'h1',
    whaleAddress: WHALE,
    coin: 'BTC',
    side: 'B',
    px: '50000',
    sz: '0.1',
    whaleTs: 1700000000000,
    emittedAt: 1700000000001,
    ...over,
  };
}

describe('evaluateMirror — skip branches', () => {
  it('skips when intent is invalid', async () => {
    const d = await evaluateMirror({ foo: 'bar' }, makeDeps({ user: user(), sub: sub() }));
    expect(d.kind).toBe('skip');
    if (d.kind === 'skip') expect(d.reason).toBe('invalid_intent');
  });
  it('skips on global kill', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({ user: user(), sub: sub(), globalKill: true }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'global_kill' });
  });
  it('skips when user not found', async () => {
    const d = await evaluateMirror(intent(), makeDeps({ user: undefined, sub: sub() }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'user_not_found' });
  });
  it('skips when user kill_switch is set', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({ user: user({ killSwitch: true }), sub: sub() }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'user_killed' });
  });
  it('skips when user is revoked', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({ user: user({ revoked: true }), sub: sub() }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'user_revoked' });
  });
  it('skips when subscription is missing', async () => {
    const d = await evaluateMirror(intent(), makeDeps({ user: user(), sub: undefined }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'subscription_not_found' });
  });
  it('skips when subscription is paused', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({ user: user(), sub: sub({ paused: true }) }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'subscription_paused' });
  });
  it('skips when coin not in allowedCoins', async () => {
    const d = await evaluateMirror(
      intent({ coin: 'SOL' }),
      makeDeps({ user: user(), sub: sub({ allowedCoins: ['BTC'] }), assets: { SOL: 5 } }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'coin_not_allowed' });
  });
  it('skips when asset is unknown', async () => {
    const d = await evaluateMirror(intent({ coin: 'ZZZ' }), makeDeps({ user: user(), sub: sub() }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'asset_unknown' });
  });
  it('skips when current fee exceeds protocol cap', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({
        user: user({ currentFeeTenthsBp: 200, approvedMaxFeeTenthsBp: 200 }),
        sub: sub(),
      }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'fee_exceeds_cap' });
  });
  it('skips when current fee exceeds approved fee', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({
        user: user({ currentFeeTenthsBp: 80, approvedMaxFeeTenthsBp: 50 }),
        sub: sub(),
      }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'fee_exceeds_cap' });
  });
  it('skips when price is non-positive', async () => {
    const d = await evaluateMirror(intent({ px: '0' }), makeDeps({ user: user(), sub: sub() }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'invalid_price' });
  });
  it('skips when derived size rounds below minSz', async () => {
    const d = await evaluateMirror(
      intent({ px: '1000000000' }),
      makeDeps({ user: user(), sub: sub({ maxSizeUsd: '1' }) }),
    );
    expect(d).toMatchObject({ kind: 'skip', reason: 'size_zero' });
  });
});

describe('evaluateMirror — submit branch', () => {
  it('emits a buildable HL order action with builder field', async () => {
    const d = await evaluateMirror(intent(), makeDeps({ user: user(), sub: sub() }));
    expect(d.kind).toBe('submit');
    if (d.kind !== 'submit') return;
    expect(d.action.type).toBe('order');
    expect(d.action.builder.b).toBe(BUILDER);
    expect(d.action.builder.f).toBe(30);
    expect(d.action.orders).toHaveLength(1);
    const o = d.action.orders[0]!;
    expect(o.a).toBe(0);
    expect(o.b).toBe(true);
    expect(o.r).toBe(false);
    expect(o.c).toBe(d.cloid);
    expect(d.orderIntent.tif).toBe('Ioc');
  });

  it('derives sz = maxSizeUsd / px and respects 4-decimal precision', async () => {
    const d = await evaluateMirror(
      intent({ px: '50000' }),
      makeDeps({ user: user(), sub: sub({ maxSizeUsd: '500' }) }),
    );
    expect(d.kind).toBe('submit');
    if (d.kind !== 'submit') return;
    expect(d.orderIntent.sz).toBe('0.01');
    expect(d.mirrorSizeUsd).toBe(500);
  });

  it('clamps fee to approved max even if requested current is higher (defense in depth)', async () => {
    const d = await evaluateMirror(
      intent(),
      makeDeps({
        user: user({ currentFeeTenthsBp: 50, approvedMaxFeeTenthsBp: 50 }),
        sub: sub(),
      }),
    );
    if (d.kind !== 'submit') throw new Error('expected submit');
    expect(d.action.builder.f).toBe(50);
    expect(d.feeTenthsBp).toBe(50);
  });

  it('produces a deterministic 32-hex-char cloid for the same idempotency key', async () => {
    const d1 = await evaluateMirror(intent(), makeDeps({ user: user(), sub: sub() }));
    const d2 = await evaluateMirror(intent(), makeDeps({ user: user(), sub: sub() }));
    if (d1.kind !== 'submit' || d2.kind !== 'submit') throw new Error('expected submit');
    expect(d1.cloid).toBe(d2.cloid);
    expect(d1.cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('handles sells (side=S → b:false)', async () => {
    const d = await evaluateMirror(intent({ side: 'S' }), makeDeps({ user: user(), sub: sub() }));
    if (d.kind !== 'submit') throw new Error('expected submit');
    expect(d.action.orders[0]!.b).toBe(false);
  });

  it('passes when allowedCoins is null (open) and coin is anything resolvable', async () => {
    const d = await evaluateMirror(
      intent({ coin: 'ETH' }),
      makeDeps({ user: user(), sub: sub({ allowedCoins: null }) }),
    );
    if (d.kind !== 'submit') throw new Error('expected submit');
    expect(d.action.orders[0]!.a).toBe(1);
  });
});
