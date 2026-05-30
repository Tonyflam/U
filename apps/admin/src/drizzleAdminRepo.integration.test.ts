import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestHarness } from '@whalepod/schema/testHarness';
import { schema } from '@whalepod/schema';
import { DrizzleAdminRepo } from './drizzleAdminRepo.js';

const WHALE_ADDR = '0xabcd000000000000000000000000000000000001';
const WHALE_ADDR_2 = '0xabcd000000000000000000000000000000000002';

describe('DrizzleAdminRepo (pglite integration)', () => {
  let h: TestHarness;
  let repo: DrizzleAdminRepo;
  let userId: string;

  beforeAll(async () => {
    h = await createTestDb();
    repo = new DrizzleAdminRepo(h.db);
    const [u] = await h.db
      .insert(schema.users)
      .values({
        tgUserId: 9999n,
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
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('upsertCuratedWhale inserts a whale flagged is_featured=true', async () => {
    const w = await repo.upsertCuratedWhale(WHALE_ADDR, 'AlphaCat');
    expect(w.address).toBe(WHALE_ADDR);
    expect(w.alias).toBe('AlphaCat');
    expect(w.subscriberCount).toBe(0);
  });

  it('listCuratedWhales returns only featured rows', async () => {
    // Insert an unfeatured whale; should not appear.
    await h.db
      .insert(schema.whales)
      .values({ address: '0xdead000000000000000000000000000000000000' });
    const list = await repo.listCuratedWhales();
    const addrs = list.map((w) => w.address);
    expect(addrs).toContain(WHALE_ADDR);
    expect(addrs).not.toContain('0xdead000000000000000000000000000000000000');
  });

  it('upsertCuratedWhale reports honest subscriber count', async () => {
    const whales = await repo.listCuratedWhales();
    const w = whales.find((x) => x.address === WHALE_ADDR);
    if (!w) throw new Error('whale missing');
    // Look up internal id for subscriptions FK.
    const rows = await h.db
      .select({ id: schema.whales.id })
      .from(schema.whales)
      .where(eq(schema.whales.address, WHALE_ADDR.toLowerCase()));
    const whaleId = rows[0]?.id;
    if (!whaleId) throw new Error('whale id lookup failed');
    await h.db.insert(schema.subscriptions).values({
      userId,
      whaleId,
      maxSizeUsd: '100.00',
      maxLeverage: 3,
    });
    const updated = await repo.upsertCuratedWhale(WHALE_ADDR, 'AlphaCat');
    expect(updated.subscriberCount).toBe(1);
  });

  it('removeCuratedWhale de-curates without deleting the row', async () => {
    const removed = await repo.removeCuratedWhale(WHALE_ADDR);
    expect(removed).toBe(true);
    const list = await repo.listCuratedWhales();
    expect(list.map((w) => w.address)).not.toContain(WHALE_ADDR);
    // The row still exists (subscriptions FK would otherwise break).
    const rows = await h.db
      .select({ id: schema.whales.id })
      .from(schema.whales)
      .where(eq(schema.whales.address, WHALE_ADDR.toLowerCase()));
    expect(rows).toHaveLength(1);
  });

  it('removeCuratedWhale returns false when nothing was demoted', async () => {
    const removed = await repo.removeCuratedWhale(WHALE_ADDR_2);
    expect(removed).toBe(false);
  });

  it('getUserById + setUserPaused round-trip via users.kill_switch', async () => {
    const u = await repo.getUserById(userId);
    expect(u?.paused).toBe(false);
    await repo.setUserPaused(userId, true);
    const u2 = await repo.getUserById(userId);
    expect(u2?.paused).toBe(true);
    await repo.setUserPaused(userId, false);
  });

  it('setUserRevoked round-trip via users.revoked_at', async () => {
    const u = await repo.getUserById(userId);
    expect(u?.revoked).toBe(false);
    expect(await repo.setUserRevoked(userId, true)).toBe(true);
    const u2 = await repo.getUserById(userId);
    expect(u2?.revoked).toBe(true);
    expect(await repo.setUserRevoked(userId, false)).toBe(true);
    const u3 = await repo.getUserById(userId);
    expect(u3?.revoked).toBe(false);
  });

  it('global kill round-trip uses the singleton row id=1', async () => {
    expect(await repo.getGlobalKill()).toBe(false);
    await repo.setGlobalKill(true);
    expect(await repo.getGlobalKill()).toBe(true);
    await repo.setGlobalKill(false);
    expect(await repo.getGlobalKill()).toBe(false);
  });

  it('appendAudit writes through to audit_log', async () => {
    await repo.appendAudit({
      actor: 'op:1',
      action: 'admin_integration_test',
      target: 'system',
    });
    const rows = await h.db.select().from(schema.auditLog);
    expect(rows.some((r) => r.action === 'admin_integration_test')).toBe(true);
  });
});
