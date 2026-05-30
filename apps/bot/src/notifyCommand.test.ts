import { describe, expect, it } from 'vitest';
import { handleCommand, type HandlerCtx } from './handlers.js';
import { InMemoryBotRepo } from './inMemoryBotRepo.js';

function setup() {
  const repo = new InMemoryBotRepo();
  const user = repo.seedUser({
    tgUserId: 42n,
    mainWallet: '0x1111222233334444555566667777888899990000',
  });
  const ctx: HandlerCtx = {
    tgUser: { id: 42n, username: 'bob' },
    repo,
    miniAppUrl: 'https://app.whalepod.trade',
    botUsername: 'WhalePodBot',
  };
  return { repo, ctx, user };
}

describe('handleCommand /notify', () => {
  it('shows default prefs (ON, full) for a new user', async () => {
    const { ctx } = setup();
    const replies = await handleCommand({ kind: 'notify', action: 'show' }, ctx);
    expect(replies[0]?.text).toContain('Notifications: ON');
    expect(replies[0]?.text).toContain('Format: full');
  });

  it('/notify off mutes the user and audits', async () => {
    const { ctx, repo, user } = setup();
    const replies = await handleCommand({ kind: 'notify', action: 'off' }, ctx);
    expect(replies[0]?.text).toContain('Notifications: OFF');
    expect((await repo.getNotifyPrefs(user.id)).muted).toBe(true);
    expect(repo.audit.some((a) => a.action === 'notify_off')).toBe(true);
  });

  it('/notify on unmutes and preserves compact setting', async () => {
    const { ctx, repo, user } = setup();
    await handleCommand({ kind: 'notify', action: 'compact' }, ctx);
    await handleCommand({ kind: 'notify', action: 'off' }, ctx);
    await handleCommand({ kind: 'notify', action: 'on' }, ctx);
    const prefs = await repo.getNotifyPrefs(user.id);
    expect(prefs.muted).toBe(false);
    expect(prefs.compact).toBe(true);
  });

  it('/notify compact and /notify full toggle the format', async () => {
    const { ctx, repo, user } = setup();
    await handleCommand({ kind: 'notify', action: 'compact' }, ctx);
    expect((await repo.getNotifyPrefs(user.id)).compact).toBe(true);
    await handleCommand({ kind: 'notify', action: 'full' }, ctx);
    expect((await repo.getNotifyPrefs(user.id)).compact).toBe(false);
  });

  it('prompts onboarding when user is unknown', async () => {
    const repo = new InMemoryBotRepo();
    const ctx: HandlerCtx = {
      tgUser: { id: 999n, username: null },
      repo,
      miniAppUrl: 'https://app.whalepod.trade',
      botUsername: 'WhalePodBot',
    };
    const replies = await handleCommand({ kind: 'notify', action: 'off' }, ctx);
    expect(replies[0]?.text).toContain('onboard');
  });
});
