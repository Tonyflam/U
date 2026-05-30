import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestHarness } from '@whalepod/schema/testHarness';
import { schema } from '@whalepod/schema';
import { DrizzleBotRepo } from './drizzleBotRepo.js';

const WHALE_ADDR = '0xabcd000000000000000000000000000000000001';

describe('DrizzleBotRepo (pglite integration)', () => {
  let h: TestHarness;
  let repo: DrizzleBotRepo;
  let userId: string;
  let whaleId: string;

  beforeAll(async () => {
    h = await createTestDb();
    repo = new DrizzleBotRepo(h.db);
    const [u] = await h.db
      .insert(schema.users)
      .values({
        tgUserId: 7777n,
        tgUsername: 'whaler',
        mainWallet: '0x1111111111111111111111111111111111111111',
        agentAddress: '0x2222222222222222222222222222222222222222',
        agentKeyCt: new Uint8Array([1]),
        agentKeyIv: new Uint8Array(12),
        agentKeyTag: new Uint8Array(16),
        agentDekCt: new Uint8Array([2]),
        approvedMaxFeeTenthsBp: 50,
        currentFeeTenthsBp: 30,
      })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('seed user failed');
    userId = u.id;
    const whale = await repo.upsertWhaleByAddress(WHALE_ADDR);
    whaleId = whale.id;
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('getUserByTgId returns the seeded user', async () => {
    const u = await repo.getUserByTgId(7777n);
    expect(u?.mainWallet).toBe('0x1111111111111111111111111111111111111111');
    expect(u?.killSwitch).toBe(false);
  });

  it('upsertWhaleByAddress is idempotent and stores lowercase', async () => {
    const w1 = await repo.upsertWhaleByAddress(WHALE_ADDR.toUpperCase());
    const w2 = await repo.upsertWhaleByAddress(WHALE_ADDR);
    expect(w1.id).toBe(w2.id);
    expect(w1.address).toBe(WHALE_ADDR);
  });

  it('subscribe is idempotent and returns the same row', async () => {
    const a = await repo.subscribe(userId, whaleId);
    const b = await repo.subscribe(userId, whaleId);
    expect(b.id).toBe(a.id);
    expect(a.tpBps).toBeNull();
    expect(a.slBps).toBeNull();
  });

  it('listSubscriptions returns exactly the user-owned subs', async () => {
    const list = await repo.listSubscriptions(userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.whaleId).toBe(whaleId);
  });

  it('setSubscriptionTpSl patches one field, leaving the other untouched', async () => {
    const after = await repo.setSubscriptionTpSl(userId, whaleId, { tpBps: 200 });
    expect(after?.tpBps).toBe(200);
    expect(after?.slBps).toBeNull();
    const after2 = await repo.setSubscriptionTpSl(userId, whaleId, { slBps: 500 });
    expect(after2?.tpBps).toBe(200);
    expect(after2?.slBps).toBe(500);
  });

  it('setSubscriptionTpSl with explicit null clears the field', async () => {
    const after = await repo.setSubscriptionTpSl(userId, whaleId, { tpBps: null });
    expect(after?.tpBps).toBeNull();
    expect(after?.slBps).toBe(500);
  });

  it('setSubscriptionTpSl with empty patch returns existing row without UPDATE', async () => {
    const after = await repo.setSubscriptionTpSl(userId, whaleId, {});
    expect(after?.slBps).toBe(500);
  });

  it('setSubscriptionTpSl rejects out-of-range bps via DB CHECK', async () => {
    await expect(repo.setSubscriptionTpSl(userId, whaleId, { tpBps: 10_000 })).rejects.toThrow(
      /subscriptions_tp_bps_range/u,
    );
  });

  it('setAllSubscriptionsPaused returns count of state changes, not row matches', async () => {
    const first = await repo.setAllSubscriptionsPaused(userId, true);
    expect(first).toBe(1);
    const second = await repo.setAllSubscriptionsPaused(userId, true);
    expect(second).toBe(0); // already paused — no state change
    await repo.setAllSubscriptionsPaused(userId, false);
  });

  it('setKillSwitch + setCurrentFee round-trip through the users row', async () => {
    await repo.setKillSwitch(userId, true);
    const u1 = await repo.getUserByTgId(7777n);
    expect(u1?.killSwitch).toBe(true);
    await repo.setKillSwitch(userId, false);
    await repo.setCurrentFee(userId, 50);
    const u2 = await repo.getUserByTgId(7777n);
    expect(u2?.currentFeeTenthsBp).toBe(50);
  });

  it('setCurrentFee above approved is rejected by DB CHECK', async () => {
    await expect(repo.setCurrentFee(userId, 60)).rejects.toThrow(/users_current_fee_nonneg/u);
  });

  it('unsubscribe deletes and returns true; second call returns false', async () => {
    const a = await repo.unsubscribe(userId, whaleId);
    expect(a).toBe(true);
    const b = await repo.unsubscribe(userId, whaleId);
    expect(b).toBe(false);
  });

  it('appendAudit writes a row with the expected actor/action', async () => {
    await repo.appendAudit({
      actor: 'tg:7777',
      action: 'integration_test',
      target: `user:${userId}`,
      before: { x: 1 },
      after: { x: 2 },
    });
    const rows = await h.db.select().from(schema.auditLog);
    expect(rows.some((r) => r.action === 'integration_test')).toBe(true);
  });
});
