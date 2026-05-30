import { describe, expect, it } from 'vitest';
import { Address } from '@whalepod/schema';
import { handleAdminCommand, parseAdminCommand, type AdminCtx } from './admin.js';
import { InMemoryAdminRepo } from './inMemoryAdminRepo.js';

const OP_TG = 100n;
const STRANGER_TG = 999n;
const WHALE = Address.parse('0xabcd000000000000000000000000000000000001');
const WHALE2 = Address.parse('0xabcd000000000000000000000000000000000002');

function setup(opts: { actorTgId?: bigint } = {}) {
  const repo = new InMemoryAdminRepo();
  const ctx: AdminCtx = {
    actorTgId: opts.actorTgId ?? OP_TG,
    operators: new Set([OP_TG]),
    repo,
  };
  return { repo, ctx };
}

describe('parseAdminCommand', () => {
  it('parses every operator command', () => {
    expect(parseAdminCommand('/whales')).toStrictEqual({ kind: 'whales' });
    expect(parseAdminCommand('/add_whale 0xabc alpha cat')).toStrictEqual({
      kind: 'add_whale',
      address: '0xabc',
      alias: 'alpha cat',
    });
    expect(parseAdminCommand('/add_whale 0xabc')).toStrictEqual({
      kind: 'add_whale',
      address: '0xabc',
      alias: null,
    });
    expect(parseAdminCommand('/remove_whale 0xabc')).toStrictEqual({
      kind: 'remove_whale',
      address: '0xabc',
    });
    expect(parseAdminCommand('/pause_user u-001')).toStrictEqual({
      kind: 'pause_user',
      userId: 'u-001',
    });
    expect(parseAdminCommand('/resume_user u-001')).toStrictEqual({
      kind: 'resume_user',
      userId: 'u-001',
    });
    expect(parseAdminCommand('/global_kill')?.kind).toBe('global_kill');
    expect(parseAdminCommand('/global_unkill')?.kind).toBe('global_unkill');
    expect(parseAdminCommand('/help')?.kind).toBe('help');
  });

  it('returns unknown for missing required args', () => {
    expect(parseAdminCommand('/pause_user')).toMatchObject({ kind: 'unknown' });
    expect(parseAdminCommand('/remove_whale')).toMatchObject({ kind: 'unknown' });
  });

  it('returns null for non-command text', () => {
    expect(parseAdminCommand('hi')).toBeNull();
  });
});

describe('authorization', () => {
  it('refuses every command from a non-operator tg id', async () => {
    const { ctx, repo } = setup({ actorTgId: STRANGER_TG });
    const cases = [
      { kind: 'whales' as const },
      { kind: 'add_whale' as const, address: WHALE, alias: null },
      { kind: 'global_kill' as const },
      { kind: 'help' as const },
    ];
    for (const cmd of cases) {
      const r = await handleAdminCommand(cmd, ctx);
      expect(r[0]?.text).toBe('Not authorized.');
    }
    expect(repo.audit).toHaveLength(0);
  });
});

describe('/whales', () => {
  it('reports empty state', async () => {
    const { ctx } = setup();
    const r = await handleAdminCommand({ kind: 'whales' }, ctx);
    expect(r[0]?.text).toMatch(/No curated whales/);
  });

  it('lists each whale with subscriber count', async () => {
    const { repo, ctx } = setup();
    await repo.upsertCuratedWhale(WHALE, 'AlphaCat');
    await repo.upsertCuratedWhale(WHALE2, null);
    const r = await handleAdminCommand({ kind: 'whales' }, ctx);
    expect(r[0]?.text).toMatch(/AlphaCat/);
    expect(r[0]?.text).toMatch(/0xabcd…0002/);
  });
});

describe('/add_whale and /remove_whale', () => {
  it('rejects non-address input', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand({ kind: 'add_whale', address: 'alice', alias: null }, ctx);
    expect(r[0]?.text).toMatch(/not a 0x address/);
    expect(repo.audit).toHaveLength(0);
  });

  it('rejects overly long alias', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand(
      { kind: 'add_whale', address: WHALE, alias: 'x'.repeat(65) },
      ctx,
    );
    expect(r[0]?.text).toMatch(/64 characters or fewer/);
    expect(repo.audit).toHaveLength(0);
  });

  it('upserts a whale and audits the action', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand(
      { kind: 'add_whale', address: WHALE, alias: 'AlphaCat' },
      ctx,
    );
    expect(r[0]?.text).toMatch(/Curated whale upserted: AlphaCat/);
    expect(repo.audit.at(-1)?.action).toBe('admin_add_whale');
  });

  it('removes a whale and audits the action', async () => {
    const { repo, ctx } = setup();
    await repo.upsertCuratedWhale(WHALE, null);
    const r = await handleAdminCommand({ kind: 'remove_whale', address: WHALE }, ctx);
    expect(r[0]?.text).toMatch(/removed/);
    expect(repo.audit.at(-1)?.action).toBe('admin_remove_whale');
  });

  it('reports gracefully when removing a missing whale', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand({ kind: 'remove_whale', address: WHALE }, ctx);
    expect(r[0]?.text).toMatch(/No curated whale/);
    expect(repo.audit).toHaveLength(0);
  });
});

describe('/pause_user and /resume_user', () => {
  it('pauses an active user with an audit entry', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: false, revoked: false });
    const r = await handleAdminCommand({ kind: 'pause_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/paused/);
    expect(repo.audit.at(-1)?.action).toBe('admin_pause_user');
  });

  it('refuses unknown user id with no audit', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand({ kind: 'pause_user', userId: 'u-?' }, ctx);
    expect(r[0]?.text).toMatch(/No user/);
    expect(repo.audit).toHaveLength(0);
  });

  it('no-ops when user is already in the requested state', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: true, revoked: false });
    const before = repo.audit.length;
    const r = await handleAdminCommand({ kind: 'pause_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/already paused/);
    expect(repo.audit.length).toBe(before);
  });

  it('resumes a paused user', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: true, revoked: false });
    const r = await handleAdminCommand({ kind: 'resume_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/resumed/);
    expect(repo.audit.at(-1)?.action).toBe('admin_resume_user');
  });
});

describe('/revoke_user and /unrevoke_user', () => {
  it('parses both commands', () => {
    expect(parseAdminCommand('/revoke_user u-001')).toStrictEqual({
      kind: 'revoke_user',
      userId: 'u-001',
    });
    expect(parseAdminCommand('/unrevoke_user u-001')).toStrictEqual({
      kind: 'unrevoke_user',
      userId: 'u-001',
    });
    expect(parseAdminCommand('/revoke_user')).toMatchObject({ kind: 'unknown' });
  });

  it('revokes an active user with an audit entry', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: false, revoked: false });
    const r = await handleAdminCommand({ kind: 'revoke_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/REVOKED/);
    expect(repo.audit.at(-1)?.action).toBe('admin_revoke_user');
    expect(repo.users.get('u-001')?.revoked).toBe(true);
  });

  it('no-ops when already revoked', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: false, revoked: true });
    const before = repo.audit.length;
    const r = await handleAdminCommand({ kind: 'revoke_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/already revoked/);
    expect(repo.audit.length).toBe(before);
  });

  it('unrevokes a revoked user', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: false, revoked: true });
    const r = await handleAdminCommand({ kind: 'unrevoke_user', userId: 'u-001' }, ctx);
    expect(r[0]?.text).toMatch(/unrevoked/);
    expect(repo.audit.at(-1)?.action).toBe('admin_unrevoke_user');
    expect(repo.users.get('u-001')?.revoked).toBe(false);
  });

  it('refuses unknown user id', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand({ kind: 'revoke_user', userId: 'u-?' }, ctx);
    expect(r[0]?.text).toMatch(/No user/);
    expect(repo.audit).toHaveLength(0);
  });
});

describe('/global_kill', () => {
  it('engages the global kill with an audit entry', async () => {
    const { repo, ctx } = setup();
    const r = await handleAdminCommand({ kind: 'global_kill' }, ctx);
    expect(r[0]?.text).toMatch(/GLOBAL KILL ENGAGED/);
    expect(await repo.getGlobalKill()).toBe(true);
    expect(repo.audit.at(-1)?.action).toBe('admin_global_kill_on');
  });

  it('no-ops when already in the requested state', async () => {
    const { repo, ctx } = setup();
    await handleAdminCommand({ kind: 'global_kill' }, ctx);
    const before = repo.audit.length;
    const r = await handleAdminCommand({ kind: 'global_kill' }, ctx);
    expect(r[0]?.text).toMatch(/already ON/);
    expect(repo.audit.length).toBe(before);
  });

  it('clears the global kill', async () => {
    const { repo, ctx } = setup();
    await handleAdminCommand({ kind: 'global_kill' }, ctx);
    const r = await handleAdminCommand({ kind: 'global_unkill' }, ctx);
    expect(r[0]?.text).toMatch(/cleared/);
    expect(await repo.getGlobalKill()).toBe(false);
    expect(repo.audit.at(-1)?.action).toBe('admin_global_kill_off');
  });
});

describe('audit invariant', () => {
  it('every successful admin mutation appends exactly one audit entry', async () => {
    const { repo, ctx } = setup();
    repo.seedUser({ id: 'u-001', tgUserId: 1n, paused: false, revoked: false });
    await handleAdminCommand({ kind: 'add_whale', address: WHALE, alias: 'AlphaCat' }, ctx);
    await handleAdminCommand({ kind: 'pause_user', userId: 'u-001' }, ctx);
    await handleAdminCommand({ kind: 'global_kill' }, ctx);
    await handleAdminCommand({ kind: 'global_unkill' }, ctx);
    await handleAdminCommand({ kind: 'remove_whale', address: WHALE }, ctx);
    expect(repo.audit.map((a) => a.action)).toStrictEqual([
      'admin_add_whale',
      'admin_pause_user',
      'admin_global_kill_on',
      'admin_global_kill_off',
      'admin_remove_whale',
    ]);
  });

  it('every audit entry includes the operator tg id in the actor field', async () => {
    const { repo, ctx } = setup();
    await handleAdminCommand({ kind: 'add_whale', address: WHALE, alias: null }, ctx);
    expect(repo.audit.at(-1)?.actor).toBe(`op:${OP_TG.toString()}`);
  });
});

describe('handleAdminCommand /stats', () => {
  it('refuses non-operators', async () => {
    const repo = new InMemoryAdminRepo();
    const ctx = { actorTgId: 999n, operators: new Set([1n]), repo };
    const replies = await handleAdminCommand({ kind: 'stats' }, ctx);
    expect(replies[0]?.text).toMatch(/not authorized/i);
  });

  it('renders system snapshot for operators', async () => {
    const repo = new InMemoryAdminRepo();
    repo.stats = {
      userCount: 42,
      activeSubscriptionCount: 17,
      curatedWhaleCount: 5,
      fills24h: 123,
      builderFeesUsd24h: 4.56,
      globalKill: false,
    };
    const ctx = { actorTgId: 1n, operators: new Set([1n]), repo };
    const replies = await handleAdminCommand({ kind: 'stats' }, ctx);
    const text = replies[0]?.text ?? '';
    expect(text).toMatch(/System stats/);
    expect(text).toMatch(/Users: 42/);
    expect(text).toMatch(/Active subs: 17/);
    expect(text).toMatch(/Fills \(24h\): 123/);
    expect(text).toMatch(/\$4\.56/);
  });

  it('parses /stats command', () => {
    expect(parseAdminCommand('/stats')?.kind).toBe('stats');
  });
});
