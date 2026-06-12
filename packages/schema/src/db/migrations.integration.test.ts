/**
 * Integration tests: every CHECK constraint and unique-index invariant we
 * declared in `schema.ts` must be enforced by the actual migrations when
 * applied to a real Postgres (pglite). Catches drift between
 * `schema.ts` (the Drizzle source of truth) and the SQL we ship.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestHarness } from './testHarness.js';
import * as schema from './schema.js';

describe('migrations integration (pglite)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  async function insertUser(
    overrides: Partial<{
      approvedMaxFeeTenthsBp: number;
      currentFeeTenthsBp: number;
      tgUserId: bigint;
    }> = {},
  ): Promise<{ id: string }> {
    const [row] = await h.db
      .insert(schema.users)
      .values({
        tgUserId: overrides.tgUserId ?? BigInt(Math.floor(Math.random() * 1_000_000_000)),
        mainWallet: '0x1111111111111111111111111111111111111111',
        agentAddress: '0x2222222222222222222222222222222222222222',
        agentKeyCt: new Uint8Array([1]),
        agentKeyIv: new Uint8Array(12),
        agentKeyTag: new Uint8Array(16),
        agentDekCt: new Uint8Array([2]),
        approvedMaxFeeTenthsBp: overrides.approvedMaxFeeTenthsBp ?? 50,
        currentFeeTenthsBp: overrides.currentFeeTenthsBp ?? 30,
      })
      .returning({ id: schema.users.id });
    if (!row) throw new Error('insertUser returned nothing');
    return row;
  }

  async function insertWhale(): Promise<{ id: string }> {
    const addr = `0x${Math.floor(Math.random() * 1e15)
      .toString(16)
      .padStart(40, '0')
      .slice(0, 40)}`;
    const [row] = await h.db
      .insert(schema.whales)
      .values({ address: addr })
      .returning({ id: schema.whales.id });
    if (!row) throw new Error('insertWhale returned nothing');
    return row;
  }

  it('users.approved_max_fee CHECK rejects values above 100', async () => {
    await expect(insertUser({ approvedMaxFeeTenthsBp: 101 })).rejects.toThrow(
      /users_approved_max_fee_nonneg/u,
    );
  });

  it('users.current_fee CHECK rejects values above approved', async () => {
    await expect(
      insertUser({ approvedMaxFeeTenthsBp: 50, currentFeeTenthsBp: 51 }),
    ).rejects.toThrow(/users_current_fee_nonneg/u);
  });

  it('subscriptions.max_leverage CHECK rejects > 50', async () => {
    const u = await insertUser();
    const w = await insertWhale();
    await expect(
      h.db.insert(schema.subscriptions).values({
        userId: u.id,
        whaleId: w.id,
        maxSizeUsd: '100.00',
        maxLeverage: 51,
      }),
    ).rejects.toThrow(/subscriptions_leverage_range/u);
  });

  it('subscriptions.max_size_usd CHECK rejects 0', async () => {
    const u = await insertUser();
    const w = await insertWhale();
    await expect(
      h.db.insert(schema.subscriptions).values({
        userId: u.id,
        whaleId: w.id,
        maxSizeUsd: '0',
        maxLeverage: 3,
      }),
    ).rejects.toThrow(/subscriptions_max_size_positive/u);
  });

  it('subscriptions.tp_bps CHECK rejects 0 and 10000, accepts 1..9999 and NULL', async () => {
    const u = await insertUser();
    const w = await insertWhale();
    await expect(
      h.db.insert(schema.subscriptions).values({
        userId: u.id,
        whaleId: w.id,
        maxSizeUsd: '100.00',
        maxLeverage: 3,
        tpBps: 0,
      }),
    ).rejects.toThrow(/subscriptions_tp_bps_range/u);
    await expect(
      h.db.insert(schema.subscriptions).values({
        userId: u.id,
        whaleId: w.id,
        maxSizeUsd: '100.00',
        maxLeverage: 3,
        tpBps: 10_000,
      }),
    ).rejects.toThrow(/subscriptions_tp_bps_range/u);
    // Boundary values accepted.
    await h.db.insert(schema.subscriptions).values({
      userId: u.id,
      whaleId: w.id,
      maxSizeUsd: '100.00',
      maxLeverage: 3,
      tpBps: 1,
      slBps: 9999,
    });
  });

  it('subscriptions_user_whale_unique blocks duplicate (user, whale) pair', async () => {
    const u = await insertUser();
    const w = await insertWhale();
    await h.db.insert(schema.subscriptions).values({
      userId: u.id,
      whaleId: w.id,
      maxSizeUsd: '100.00',
      maxLeverage: 3,
    });
    await expect(
      h.db.insert(schema.subscriptions).values({
        userId: u.id,
        whaleId: w.id,
        maxSizeUsd: '200.00',
        maxLeverage: 5,
      }),
    ).rejects.toThrow(/subscriptions_user_whale_unique/u);
  });

  it('fills.side CHECK rejects sides other than B or S', async () => {
    await expect(
      h.db.insert(schema.fills).values({
        hlFillId: 'hl-1',
        wallet: '0x1111111111111111111111111111111111111111',
        coin: 'BTC',
        side: 'X',
        px: '50000.00000000',
        sz: '0.10000000',
        notionalUsd: '5000.00',
        isMirror: false,
        ts: new Date(),
      }),
    ).rejects.toThrow(/fills_side_check/u);
  });

  it('kill_switches_global CHECK enforces singleton id=1', async () => {
    await expect(
      h.db.insert(schema.killSwitchesGlobal).values({ id: 2, enabled: true }),
    ).rejects.toThrow(/kill_switches_global_singleton/u);
    // id=1 accepted.
    await h.db.insert(schema.killSwitchesGlobal).values({ id: 1, enabled: false });
  });

  it('users.tg_user_id unique blocks duplicate Telegram ids', async () => {
    const tg = 424242n;
    await insertUser({ tgUserId: tg });
    await expect(insertUser({ tgUserId: tg })).rejects.toThrow(/tg_user_id/u);
  });

  it('watches_tg_whale_unique blocks duplicate (tg_user, whale) and cascades on whale delete', async () => {
    const whale = await insertWhale();
    const tg = 31337n;
    await h.db.insert(schema.watches).values({ tgUserId: tg, whaleId: whale.id });
    await expect(
      h.db.insert(schema.watches).values({ tgUserId: tg, whaleId: whale.id }),
    ).rejects.toThrow(/watches_tg_whale_unique/u);

    // Cascade: deleting the whale removes its watches.
    await h.db.delete(schema.whales).where(sql`${schema.whales.id} = ${whale.id}`);
    const left = await h.db
      .select()
      .from(schema.watches)
      .where(sql`${schema.watches.tgUserId} = ${tg}`);
    expect(left).toHaveLength(0);
  });

  it('all eight tables exist after migration', async () => {
    const result = await h.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const names = result.rows.map((r) => (r as { table_name: string }).table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'audit_log',
        'fills',
        'kill_switches_global',
        'referrals',
        'referrals_attribution',
        'subscriptions',
        'users',
        'watches',
        'whales',
      ]),
    );
  });
});
