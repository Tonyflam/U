/**
 * Drizzle-backed snapshot loaders consumed by `evaluateMirror`.
 *
 * Two narrow read paths, both keyed by primary-key uuid so the planner
 * uses the unique indexes. We deliberately return only the fields the
 * pure engine needs — keeping the snapshot shape minimal limits blast
 * radius if the schema grows.
 *
 *  - `DrizzleUserSnapshotLookup.byId(userId)` → `UserSnapshot | undefined`
 *  - `DrizzleSubscriptionSnapshotLookup.forUserAndWhale(userId, whale)`
 *      joins `subscriptions` → `whales` (the engine compares against the
 *      lowercase whale address, never the whale row's uuid).
 */
import { and, eq } from 'drizzle-orm';
import { schema, type AnyDb } from '@whalepod/schema';
import type { SubscriptionSnapshot, UserSnapshot } from './mirrorEngine.js';

export class DrizzleUserSnapshotLookup {
  constructor(private readonly db: AnyDb) {}

  async byId(userId: string): Promise<UserSnapshot | undefined> {
    const rows = await this.db
      .select({
        id: schema.users.id,
        killSwitch: schema.users.killSwitch,
        revokedAt: schema.users.revokedAt,
        agentAddress: schema.users.agentAddress,
        approvedMaxFeeTenthsBp: schema.users.approvedMaxFeeTenthsBp,
        currentFeeTenthsBp: schema.users.currentFeeTenthsBp,
        equityFloorUsd: schema.users.equityFloorUsd,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      killSwitch: row.killSwitch,
      revoked: row.revokedAt !== null,
      agentAddress: row.agentAddress,
      approvedMaxFeeTenthsBp: row.approvedMaxFeeTenthsBp,
      currentFeeTenthsBp: row.currentFeeTenthsBp,
      equityFloorUsd: row.equityFloorUsd,
    };
  }
}

export class DrizzleSubscriptionSnapshotLookup {
  constructor(private readonly db: AnyDb) {}

  async forUserAndWhale(
    userId: string,
    whaleAddress: string,
  ): Promise<SubscriptionSnapshot | undefined> {
    const addr = whaleAddress.toLowerCase();
    const rows = await this.db
      .select({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        whaleAddress: schema.whales.address,
        paused: schema.subscriptions.paused,
        maxSizeUsd: schema.subscriptions.maxSizeUsd,
        maxLeverage: schema.subscriptions.maxLeverage,
        allowedCoins: schema.subscriptions.allowedCoins,
        tpBps: schema.subscriptions.tpBps,
        slBps: schema.subscriptions.slBps,
      })
      .from(schema.subscriptions)
      .innerJoin(schema.whales, eq(schema.whales.id, schema.subscriptions.whaleId))
      .where(and(eq(schema.subscriptions.userId, userId), eq(schema.whales.address, addr)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      whaleAddress: row.whaleAddress,
      paused: row.paused,
      maxSizeUsd: row.maxSizeUsd,
      maxLeverage: row.maxLeverage,
      allowedCoins: row.allowedCoins,
      tpBps: row.tpBps,
      slBps: row.slBps,
    };
  }
}
