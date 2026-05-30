/**
 * Drizzle-backed implementation of `AdminRepo`.
 *
 * Mapping notes:
 *  - "Curated whales" = rows in `whales` with `is_featured = true`. The
 *    `whales` table itself is the union of all observed whales (populated
 *    by the bot's `/follow` upserts); the admin surface promotes a row to
 *    "curated" by flipping `is_featured`. Removing curation does NOT delete
 *    the whale row (subscriptions might still reference it).
 *  - "Pause user" = flip `users.kill_switch`. This is the same boolean the
 *    bot exposes via `/kill`; the admin can override either direction. The
 *    global kill (`kill_switches_global` singleton id=1) is a separate
 *    system-wide latch checked by the order router on every fill.
 *  - `subscriberCount` = `COUNT(*)` of `subscriptions` joined on whale id.
 *    Computed per-row in `listCuratedWhales`; the table is bounded (<1k
 *    curated whales) so a single GROUP BY is fine.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, type AnyDb } from '@whalepod/schema';
import type { z } from 'zod';
import type { Address } from '@whalepod/schema';
import type { AdminRepo, AdminStats, AdminUser, AdminWhale } from './admin.js';

type AddressValue = z.infer<typeof Address>;

const GLOBAL_KILL_ID = 1;

export class DrizzleAdminRepo implements AdminRepo {
  constructor(private readonly db: AnyDb) {}

  async listCuratedWhales(): Promise<readonly AdminWhale[]> {
    const rows = await this.db
      .select({
        address: schema.whales.address,
        alias: schema.whales.alias,
        subscriberCount: sql<number>`COUNT(${schema.subscriptions.id})::int`,
      })
      .from(schema.whales)
      .leftJoin(schema.subscriptions, eq(schema.subscriptions.whaleId, schema.whales.id))
      .where(eq(schema.whales.isFeatured, true))
      .groupBy(schema.whales.id, schema.whales.address, schema.whales.alias);
    return rows.map((r) => ({
      address: r.address,
      alias: r.alias,
      subscriberCount: r.subscriberCount,
    }));
  }

  async upsertCuratedWhale(address: AddressValue, alias: string | null): Promise<AdminWhale> {
    const [row] = await this.db
      .insert(schema.whales)
      .values({ address, alias, isFeatured: true })
      .onConflictDoUpdate({
        target: schema.whales.address,
        set: { alias, isFeatured: true },
      })
      .returning({
        id: schema.whales.id,
        address: schema.whales.address,
        alias: schema.whales.alias,
      });
    if (!row) throw new Error(`upsertCuratedWhale: no row returned for ${address}`);
    // Fresh upsert may have zero subscribers, but if the address already
    // existed we don't want to lie. One small COUNT query keeps this honest.
    const [{ count } = { count: 0 }] = await this.db
      .select({
        count: sql<number>`COUNT(${schema.subscriptions.id})::int`,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.whaleId, row.id));
    return {
      address: row.address,
      alias: row.alias,
      subscriberCount: count,
    };
  }

  async removeCuratedWhale(address: AddressValue): Promise<boolean> {
    // De-curate, don't delete: existing subscriptions reference the row.
    const rows = await this.db
      .update(schema.whales)
      .set({ isFeatured: false })
      .where(and(eq(schema.whales.address, address), eq(schema.whales.isFeatured, true)))
      .returning({ id: schema.whales.id });
    return rows.length > 0;
  }

  async getUserById(userId: string): Promise<AdminUser | null> {
    const rows = await this.db
      .select({
        id: schema.users.id,
        tgUserId: schema.users.tgUserId,
        paused: schema.users.killSwitch,
        revokedAt: schema.users.revokedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tgUserId: row.tgUserId,
      paused: row.paused,
      revoked: row.revokedAt !== null,
    };
  }

  async setUserPaused(userId: string, paused: boolean): Promise<boolean> {
    const rows = await this.db
      .update(schema.users)
      .set({ killSwitch: paused })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id });
    return rows.length > 0;
  }

  async setUserRevoked(userId: string, revoked: boolean): Promise<boolean> {
    const rows = await this.db
      .update(schema.users)
      .set({ revokedAt: revoked ? new Date() : null })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id });
    return rows.length > 0;
  }

  async getGlobalKill(): Promise<boolean> {
    const rows = await this.db
      .select({ enabled: schema.killSwitchesGlobal.enabled })
      .from(schema.killSwitchesGlobal)
      .where(eq(schema.killSwitchesGlobal.id, GLOBAL_KILL_ID))
      .limit(1);
    return rows[0]?.enabled ?? false;
  }

  async setGlobalKill(killSwitch: boolean): Promise<void> {
    await this.db
      .insert(schema.killSwitchesGlobal)
      .values({
        id: GLOBAL_KILL_ID,
        enabled: killSwitch,
        setAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.killSwitchesGlobal.id,
        set: { enabled: killSwitch, setAt: new Date() },
      });
  }

  async appendAudit(entry: {
    actor: string;
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      beforeJson: entry.before ?? null,
      afterJson: entry.after ?? null,
    });
  }

  async getStats(): Promise<AdminStats> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [users] = await this.db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.users);
    const [subs] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.paused, false));
    const [whales] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.whales)
      .where(eq(schema.whales.isFeatured, true));
    const [fills] = await this.db
      .select({
        n: sql<number>`COUNT(*)::int`,
        fees: sql<string>`COALESCE(SUM(${schema.fills.builderFeeUsd}), 0)`,
      })
      .from(schema.fills)
      .where(and(eq(schema.fills.isMirror, true), gte(schema.fills.ts, since)));
    const [kill] = await this.db
      .select({ enabled: schema.killSwitchesGlobal.enabled })
      .from(schema.killSwitchesGlobal)
      .where(eq(schema.killSwitchesGlobal.id, GLOBAL_KILL_ID))
      .limit(1);
    return {
      userCount: users?.n ?? 0,
      activeSubscriptionCount: subs?.n ?? 0,
      curatedWhaleCount: whales?.n ?? 0,
      fills24h: fills?.n ?? 0,
      builderFeesUsd24h: Number(fills?.fees ?? '0'),
      globalKill: kill?.enabled ?? false,
    };
  }
}
