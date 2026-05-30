import { describe, expect, it } from 'vitest';
import { handleCommand, type HandlerCtx } from './handlers.js';
import { InMemoryBotRepo } from './inMemoryBotRepo.js';

const MINIAPP = 'https://app.whalepod.trade';
const WHALE = '0xabcd000000000000000000000000000000000001';
const WHALE2 = '0xabcd000000000000000000000000000000000002';

function setup(opts: { onboarded?: boolean; tgId?: bigint } = {}) {
  const repo = new InMemoryBotRepo();
  const tgId = opts.tgId ?? 1n;
  if (opts.onboarded !== false) {
    repo.seedUser({ tgUserId: tgId, mainWallet: '0x1111222233334444555566667777888899990000' });
  }
  const ctx: HandlerCtx = {
    tgUser: { id: tgId, username: 'alice' },
    repo,
    miniAppUrl: MINIAPP,
    botUsername: 'WhalePodBot',
  };
  return { repo, ctx };
}

describe('handleCommand /start', () => {
  it('prompts onboarding when user is unknown', async () => {
    const { ctx } = setup({ onboarded: false });
    const replies = await handleCommand({ kind: 'start', startParam: null }, ctx);
    expect(replies[0]?.text).toMatch(/onboard/i);
    expect(replies[0]?.buttons?.[0]?.[0]?.url).toBe(MINIAPP);
  });

  it('welcomes back an onboarded user', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'start', startParam: null }, ctx);
    expect(replies[0]?.text).toMatch(/welcome back/i);
  });
});

describe('handleCommand /help', () => {
  it('lists every wedge command', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'help' }, ctx);
    const text = replies[0]?.text ?? '';
    for (const cmd of ['/wallet', '/follow', '/unfollow', '/pause', '/resume', '/fee', '/kill']) {
      expect(text).toContain(cmd);
    }
  });
});

describe('handleCommand /wallet', () => {
  it('shows wallet, agent, fee, and kill switch', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'wallet' }, ctx);
    const text = replies[0]?.text ?? '';
    expect(text).toMatch(/Wallet:/);
    expect(text).toMatch(/Agent:/);
    expect(text).toMatch(/Current fee:/);
    expect(text).toMatch(/Kill switch:/);
  });

  it('redirects to onboarding when not onboarded', async () => {
    const { ctx } = setup({ onboarded: false });
    const replies = await handleCommand({ kind: 'wallet' }, ctx);
    expect(replies[0]?.text).toMatch(/onboard/i);
  });
});

describe('handleCommand /follow', () => {
  it('subscribes a new whale and writes audit', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    expect(replies[0]?.text).toMatch(/Now mirroring/);
    expect(repo.subscriptions).toHaveLength(1);
    expect(repo.audit.at(-1)?.action).toBe('subscribe');
  });

  it('is idempotent for the same whale', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    const replies = await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    expect(replies[0]?.text).toMatch(/Already following/);
    expect(repo.subscriptions).toHaveLength(1);
  });

  it('rejects non-address targets', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'follow', target: 'alice' }, ctx);
    expect(replies[0]?.text).toMatch(/not a 0x address/);
    expect(repo.subscriptions).toHaveLength(0);
  });

  it('normalizes the whale address to lowercase', async () => {
    const { repo, ctx } = setup();
    const upper = '0xABCD000000000000000000000000000000000003';
    await handleCommand({ kind: 'follow', target: upper }, ctx);
    expect(repo.whales.values().next().value?.address).toBe(upper.toLowerCase());
  });
});

describe('handleCommand /unfollow', () => {
  it('removes a subscription and writes audit', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    const replies = await handleCommand({ kind: 'unfollow', target: WHALE }, ctx);
    expect(replies[0]?.text).toMatch(/Stopped mirroring/);
    expect(repo.subscriptions).toHaveLength(0);
    expect(repo.audit.at(-1)?.action).toBe('unsubscribe');
  });

  it('reports gracefully when not subscribed', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'unfollow', target: WHALE }, ctx);
    expect(replies[0]?.text).toMatch(/Not subscribed/);
  });
});

describe('handleCommand /pause /resume', () => {
  it('pauses all subscriptions and counts them', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'follow', target: WHALE2 }, ctx);
    const replies = await handleCommand({ kind: 'pause' }, ctx);
    expect(replies[0]?.text).toBe('Paused 2 subscriptions.');
    expect(repo.subscriptions.every((s) => s.paused)).toBe(true);
    expect(repo.audit.at(-1)?.action).toBe('pause_all');
  });

  it('resume only counts subs that were actually paused', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'pause' }, ctx);
    const replies = await handleCommand({ kind: 'resume' }, ctx);
    expect(replies[0]?.text).toBe('Resumed 1 subscriptions.');
    expect(repo.subscriptions[0]?.paused).toBe(false);
  });
});

describe('handleCommand /kill /unkill', () => {
  it('turns the kill switch on and writes audit', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'kill' }, ctx);
    expect(replies[0]?.text).toMatch(/Kill switch ON/);
    expect([...repo.users.values()][0]?.killSwitch).toBe(true);
    expect(repo.audit.at(-1)?.action).toBe('kill_on');
  });

  it('is a no-op when already in the requested state', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'kill' }, ctx);
    const before = repo.audit.length;
    const replies = await handleCommand({ kind: 'kill' }, ctx);
    expect(replies[0]?.text).toMatch(/already ON/);
    expect(repo.audit.length).toBe(before);
  });
});

describe('handleCommand /fee', () => {
  it('updates the fee and writes audit', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'fee', tenthsBp: 40 }, ctx);
    expect(replies[0]?.text).toMatch(/Fee set to 4.0 bps/);
    expect([...repo.users.values()][0]?.currentFeeTenthsBp).toBe(40);
    expect(repo.audit.at(-1)?.action).toBe('set_fee');
  });

  it('refuses to exceed the on-chain approval and offers re-approve link', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'fee', tenthsBp: 75 }, ctx);
    expect(replies[0]?.text).toMatch(/exceeds your on-chain approval/);
    expect(replies[0]?.buttons?.[0]?.[0]?.url).toBe(MINIAPP);
    expect([...repo.users.values()][0]?.currentFeeTenthsBp).toBe(30);
  });

  it('refuses to exceed the protocol cap even if approval would allow it', async () => {
    const { repo, ctx } = setup();
    // raise approval to cap; still refuse > cap
    repo.users.forEach((u, id) => repo.users.set(id, { ...u, approvedMaxFeeTenthsBp: 100 }));
    const replies = await handleCommand({ kind: 'fee', tenthsBp: 101 }, ctx);
    expect(replies[0]?.text).toMatch(/exceeds protocol cap/);
  });

  it('no-ops when fee equals current', async () => {
    const { repo, ctx } = setup();
    const before = repo.audit.length;
    const replies = await handleCommand({ kind: 'fee', tenthsBp: 30 }, ctx);
    expect(replies[0]?.text).toMatch(/already at 3.0 bps/);
    expect(repo.audit.length).toBe(before);
  });
});

describe('handleCommand /unknown', () => {
  it('returns a help hint', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'unknown', raw: '/lol' }, ctx);
    expect(replies[0]?.text).toMatch(/Unknown command/);
  });
});

describe('mutation handlers always write audit when they mutate', () => {
  it('every successful mutation appends one audit entry', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'fee', tenthsBp: 40 }, ctx);
    await handleCommand({ kind: 'kill' }, ctx);
    await handleCommand({ kind: 'pause' }, ctx);
    await handleCommand({ kind: 'unfollow', target: WHALE }, ctx);
    expect(repo.audit.map((a) => a.action)).toStrictEqual([
      'subscribe',
      'set_fee',
      'kill_on',
      'pause_all',
      'unsubscribe',
    ]);
  });
});

describe('handleCommand /tp /sl', () => {
  it('sets tp on an existing subscription and writes audit', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    const replies = await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    expect(replies[0]?.text).toMatch(/TP set to 500 bps/);
    expect(repo.subscriptions[0]?.tpBps).toBe(500);
    expect(repo.audit.at(-1)?.action).toBe('set_tp');
  });

  it('sets sl independently of tp', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    await handleCommand({ kind: 'sl', target: WHALE, offsetBps: 200 }, ctx);
    expect(repo.subscriptions[0]?.tpBps).toBe(500);
    expect(repo.subscriptions[0]?.slBps).toBe(200);
  });

  it('clears tp when offsetBps is null', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    const replies = await handleCommand({ kind: 'tp', target: WHALE, offsetBps: null }, ctx);
    expect(replies[0]?.text).toMatch(/TP cleared/);
    expect(repo.subscriptions[0]?.tpBps).toBeNull();
  });

  it('refuses when not subscribed to that whale', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    expect(replies[0]?.text).toMatch(/Use \/follow first/);
    expect(repo.audit).toHaveLength(0);
  });

  it('refuses non-address target', async () => {
    const { repo, ctx } = setup();
    const replies = await handleCommand({ kind: 'sl', target: 'alice', offsetBps: 100 }, ctx);
    expect(replies[0]?.text).toMatch(/not a 0x address/);
    expect(repo.audit).toHaveLength(0);
  });

  it('no-ops when value already equals current', async () => {
    const { repo, ctx } = setup();
    await handleCommand({ kind: 'follow', target: WHALE }, ctx);
    await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    const before = repo.audit.length;
    const replies = await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    expect(replies[0]?.text).toMatch(/already at 500 bps/);
    expect(repo.audit.length).toBe(before);
  });

  it('redirects to onboarding when not onboarded', async () => {
    const { ctx } = setup({ onboarded: false });
    const replies = await handleCommand({ kind: 'tp', target: WHALE, offsetBps: 500 }, ctx);
    expect(replies[0]?.text).toMatch(/onboard/i);
  });
});

describe('handleCommand /share', () => {
  it('redirects to onboarding when not onboarded', async () => {
    const { ctx } = setup({ onboarded: false });
    const replies = await handleCommand({ kind: 'share' }, ctx);
    expect(replies[0]?.text).toMatch(/onboard/i);
  });

  it('returns a deep link with the minted referral code and a share button', async () => {
    const { ctx, repo } = setup();
    const replies = await handleCommand({ kind: 'share' }, ctx);
    const user = await repo.getUserByTgId(ctx.tgUser.id);
    if (!user) throw new Error('seeded user missing');
    const code = await repo.getOrMintReferralCode(user.id);
    expect(replies[0]?.text).toContain(`https://t.me/WhalePodBot?start=ref_${code}`);
    const btn = replies[0]?.buttons?.[0]?.[0];
    expect(btn?.label).toBe('Share on Telegram');
    expect(btn?.url).toContain('https://t.me/share/url?url=');
    expect(btn?.url).toContain(encodeURIComponent(`ref_${code}`));
  });

  it('returns the same code on repeated calls', async () => {
    const { ctx, repo } = setup();
    const r1 = await handleCommand({ kind: 'share' }, ctx);
    const r2 = await handleCommand({ kind: 'share' }, ctx);
    expect(r1[0]?.text).toBe(r2[0]?.text);
    // And the audit log was not written (read-only path).
    expect(repo.audit.length).toBe(0);
  });
});

describe('handleCommand /start with referral payload', () => {
  it('attributes a valid ref_<code> to the referring user', async () => {
    const { ctx, repo } = setup({ tgId: 100n });
    // Seed a separate referrer and mint their code.
    const referrer = repo.seedUser({
      tgUserId: 7n,
      mainWallet: '0x2222000000000000000000000000000000000000',
    });
    const code = await repo.getOrMintReferralCode(referrer.id);
    const replies = await handleCommand({ kind: 'start', startParam: `ref_${code}` }, ctx);
    expect(replies[0]?.text).toMatch(/welcome back/i);
    const referred = await repo.getUserByTgId(100n);
    if (!referred) throw new Error('referred user missing');
    expect(repo.attribution.get(referred.id)).toBe(code);
    expect(repo.audit.some((a) => a.action === 'referral_attributed')).toBe(true);
  });

  it('is idempotent — second /start does not re-attribute or double-audit', async () => {
    const { ctx, repo } = setup({ tgId: 101n });
    const referrer = repo.seedUser({
      tgUserId: 8n,
      mainWallet: '0x3333000000000000000000000000000000000000',
    });
    const code = await repo.getOrMintReferralCode(referrer.id);
    await handleCommand({ kind: 'start', startParam: `ref_${code}` }, ctx);
    await handleCommand({ kind: 'start', startParam: `ref_${code}` }, ctx);
    expect(repo.audit.filter((a) => a.action === 'referral_attributed').length).toBe(1);
  });

  it('ignores self-referral', async () => {
    const { ctx, repo } = setup({ tgId: 102n });
    const me = await repo.getUserByTgId(102n);
    if (!me) throw new Error('seeded user missing');
    const code = await repo.getOrMintReferralCode(me.id);
    await handleCommand({ kind: 'start', startParam: `ref_${code}` }, ctx);
    expect(repo.attribution.get(me.id)).toBeUndefined();
  });

  it('stashes a referral_pending audit when user not yet onboarded', async () => {
    const { ctx, repo } = setup({ onboarded: false, tgId: 103n });
    await handleCommand({ kind: 'start', startParam: 'ref_xyz123' }, ctx);
    expect(repo.audit.some((a) => a.action === 'referral_pending')).toBe(true);
  });

  it('ignores malformed payload', async () => {
    const { ctx, repo } = setup({ tgId: 104n });
    await handleCommand({ kind: 'start', startParam: 'ref_!!!' }, ctx);
    const me = await repo.getUserByTgId(104n);
    if (!me) throw new Error('user missing');
    expect(repo.attribution.get(me.id)).toBeUndefined();
  });
});

describe('handleCommand /pnl', () => {
  it('redirects to onboarding when not onboarded', async () => {
    const { ctx } = setup({ onboarded: false });
    const replies = await handleCommand({ kind: 'pnl' }, ctx);
    expect(replies[0]?.text).toMatch(/onboard/i);
  });

  it('returns the empty-state message when no fills exist', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'pnl' }, ctx);
    expect(replies[0]?.text).toMatch(/no mirrored fills/i);
  });

  it('summarises fills with realized and unrealized PnL', async () => {
    const { ctx, repo } = setup({ tgId: 200n });
    const me = await repo.getUserByTgId(200n);
    if (!me) throw new Error('user missing');
    repo.seedFill(me.id, {
      whaleAddress: WHALE as `0x${string}`,
      whaleAlias: 'WhaleOne',
      coin: 'ETH',
      side: 'B',
      px: '3000',
      sz: '1',
      notionalUsd: '3000',
      builderFeeUsd: '1.5',
      builderFeeTenthsBp: 50,
      realizedPnlUsd: '0',
      ts: 1000,
    });
    repo.seedFill(me.id, {
      whaleAddress: WHALE as `0x${string}`,
      whaleAlias: 'WhaleOne',
      coin: 'ETH',
      side: 'S',
      px: '3500',
      sz: '1',
      notionalUsd: '3500',
      builderFeeUsd: '1.75',
      builderFeeTenthsBp: 50,
      realizedPnlUsd: '500',
      ts: 2000,
    });
    const ctxWithMark: HandlerCtx = { ...ctx, markPrice: () => '3200' };
    const replies = await handleCommand({ kind: 'pnl' }, ctxWithMark);
    const text = replies[0]?.text ?? '';
    expect(text).toMatch(/PnL summary/);
    expect(text).toMatch(/WhaleOne/);
    expect(text).toMatch(/Total:/);
  });
});

describe('handleCommand /leaderboard', () => {
  it('renders top traders with viewer highlighted', async () => {
    const { ctx, repo } = setup({ tgId: 500n });
    const me = await repo.getUserByTgId(500n);
    if (!me) throw new Error('user missing');
    repo.seedLeaderboard([
      { userId: 'u-other-1', handle: '@alpha', realizedPnlUsd: 1000 },
      { userId: me.id, handle: '@me', realizedPnlUsd: 250 },
      { userId: 'u-other-2', handle: '@beta', realizedPnlUsd: -100 },
    ]);
    const replies = await handleCommand({ kind: 'leaderboard' }, ctx);
    const text = replies[0]?.text ?? '';
    expect(text).toMatch(/Top traders/);
    expect(text).toMatch(/@alpha/);
    expect(text).toMatch(/\(you\)/);
  });

  it('returns empty-state when no traders', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'leaderboard' }, ctx);
    expect(replies[0]?.text).toMatch(/no ranked traders/i);
  });
});
