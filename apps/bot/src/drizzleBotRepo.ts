/**
 * Drizzle-backed implementation of `BotRepo`.
 *
 * Mirrors the in-memory implementation 1:1 for the handler contract, but
 * persists through the shared `@whalepod/schema` Drizzle client. Every
 * mutation is a single statement — the audit-log append is a separate row
 * by design (the handler is responsible for calling both in order).
 *
 * Conventions:
 *  - Whale addresses are stored lowercase (single canonical form, see
 *    `packages/schema/src/db/types.ts`). All lookups lowercase first.
 *  - TP/SL columns are nullable integers (1..9999). `setSubscriptionTpSl`
 *    accepts `undefined` to mean "leave alone" and explicit `null` to clear.
 *  - The kill switch is per-user on `users.kill_switch`. The global kill
 *    lives in `kill_switches_global` and is owned by the admin surface.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type AnyDb } from '@whalepod/schema';
import type { BotRepo, BotUser, Subscription, Whale } from './handlers.js';
import type { NotifyPrefs } from './notify.js';
import type { PnlFill } from './pnl.js';
import type { LeaderboardEntry } from './referral.js';

export class DrizzleBotRepo implements BotRepo {
  constructor(private readonly db: AnyDb) {}

  async getUserByTgId(tgUserId: bigint): Promise<BotUser | null> {
    const rows = await this.db
      .select({
        id: schema.users.id,
        tgUserId: schema.users.tgUserId,
        tgUsername: schema.users.tgUsername,
        mainWallet: schema.users.mainWallet,
        agentAddress: schema.users.agentAddress,
        approvedMaxFeeTenthsBp: schema.users.approvedMaxFeeTenthsBp,
        currentFeeTenthsBp: schema.users.currentFeeTenthsBp,
        killSwitch: schema.users.killSwitch,
      })
      .from(schema.users)
      .where(and(eq(schema.users.tgUserId, tgUserId), isNull(schema.users.revokedAt)))
      .limit(1);
    const row = rows[0];
    return row ?? null;
  }

  async getWhaleByAddress(address: string): Promise<Whale | null> {
    const addr = address.toLowerCase();
    const rows = await this.db
      .select({
        id: schema.whales.id,
        address: schema.whales.address,
        alias: schema.whales.alias,
      })
      .from(schema.whales)
      .where(eq(schema.whales.address, addr))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertWhaleByAddress(address: string): Promise<Whale> {
    const addr = address.toLowerCase();
    const [row] = await this.db
      .insert(schema.whales)
      .values({ address: addr })
      .onConflictDoUpdate({
        target: schema.whales.address,
        // Trivial no-op SET so we always get a row back via RETURNING.
        set: { address: addr },
      })
      .returning({
        id: schema.whales.id,
        address: schema.whales.address,
        alias: schema.whales.alias,
      });
    if (!row) throw new Error(`upsertWhaleByAddress: no row returned for ${addr}`);
    return row;
  }

  async listSubscriptions(userId: string): Promise<readonly Subscription[]> {
    const rows = await this.db
      .select({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        whaleId: schema.subscriptions.whaleId,
        paused: schema.subscriptions.paused,
        tpBps: schema.subscriptions.tpBps,
        slBps: schema.subscriptions.slBps,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, userId));
    return rows;
  }

  async subscribe(userId: string, whaleId: string): Promise<Subscription> {
    // The Drizzle impl mirrors the in-memory contract: "subscribe is idempotent;
    // returns the existing row if already subscribed". `maxSizeUsd` and
    // `maxLeverage` get conservative defaults here — the miniapp is the
    // intended path for fine-grained sizing, but a `/follow` from the bot
    // should still succeed end-to-end. Tighten later via a dedicated
    // `setSubscriptionLimits` method.
    const [row] = await this.db
      .insert(schema.subscriptions)
      .values({
        userId,
        whaleId,
        maxSizeUsd: '100.00',
        maxLeverage: 3,
      })
      .onConflictDoNothing({
        target: [schema.subscriptions.userId, schema.subscriptions.whaleId],
      })
      .returning({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        whaleId: schema.subscriptions.whaleId,
        paused: schema.subscriptions.paused,
        tpBps: schema.subscriptions.tpBps,
        slBps: schema.subscriptions.slBps,
      });
    if (row) return row;
    // Conflict path: fetch the existing row.
    const existing = await this.db
      .select({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        whaleId: schema.subscriptions.whaleId,
        paused: schema.subscriptions.paused,
        tpBps: schema.subscriptions.tpBps,
        slBps: schema.subscriptions.slBps,
      })
      .from(schema.subscriptions)
      .where(
        and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.whaleId, whaleId)),
      )
      .limit(1);
    const found = existing[0];
    if (!found) throw new Error(`subscribe: row vanished for (${userId}, ${whaleId})`);
    return found;
  }

  async unsubscribe(userId: string, whaleId: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.subscriptions)
      .where(
        and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.whaleId, whaleId)),
      )
      .returning({ id: schema.subscriptions.id });
    return rows.length > 0;
  }

  async setAllSubscriptionsPaused(userId: string, paused: boolean): Promise<number> {
    const rows = await this.db
      .update(schema.subscriptions)
      .set({ paused })
      .where(
        and(
          eq(schema.subscriptions.userId, userId),
          // Only mutate rows that actually change — matches the in-memory
          // contract that returns "count of state changes", not "count of rows".
          sql`${schema.subscriptions.paused} <> ${paused}`,
        ),
      )
      .returning({ id: schema.subscriptions.id });
    return rows.length;
  }

  async setSubscriptionTpSl(
    userId: string,
    whaleId: string,
    patch: { readonly tpBps?: number | null; readonly slBps?: number | null },
  ): Promise<Subscription | null> {
    const set: { tpBps?: number | null; slBps?: number | null } = {};
    if (patch.tpBps !== undefined) set.tpBps = patch.tpBps;
    if (patch.slBps !== undefined) set.slBps = patch.slBps;
    if (Object.keys(set).length === 0) {
      // No-op patch — return the existing row as-is.
      const existing = await this.db
        .select({
          id: schema.subscriptions.id,
          userId: schema.subscriptions.userId,
          whaleId: schema.subscriptions.whaleId,
          paused: schema.subscriptions.paused,
          tpBps: schema.subscriptions.tpBps,
          slBps: schema.subscriptions.slBps,
        })
        .from(schema.subscriptions)
        .where(
          and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.whaleId, whaleId)),
        )
        .limit(1);
      return existing[0] ?? null;
    }
    const rows = await this.db
      .update(schema.subscriptions)
      .set(set)
      .where(
        and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.whaleId, whaleId)),
      )
      .returning({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        whaleId: schema.subscriptions.whaleId,
        paused: schema.subscriptions.paused,
        tpBps: schema.subscriptions.tpBps,
        slBps: schema.subscriptions.slBps,
      });
    return rows[0] ?? null;
  }

  async setKillSwitch(userId: string, killSwitch: boolean): Promise<void> {
    await this.db.update(schema.users).set({ killSwitch }).where(eq(schema.users.id, userId));
  }

  async revokeUser(userId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ revokedAt: sql`now()`, killSwitch: true })
      .where(eq(schema.users.id, userId));
  }

  async setCurrentFee(userId: string, tenthsBp: number): Promise<void> {
    // The DB CHECK constraint enforces `current <= approved`. Letting the
    // DB reject is fine — the handler has already pre-validated, this is
    // defense in depth against a misbehaving caller.
    await this.db
      .update(schema.users)
      .set({ currentFeeTenthsBp: tenthsBp })
      .where(eq(schema.users.id, userId));
  }

  async getNotifyPrefs(userId: string): Promise<NotifyPrefs> {
    const rows = await this.db
      .select({
        muted: schema.users.notifyMuted,
        compact: schema.users.notifyCompact,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return {};
    return { muted: row.muted, compact: row.compact };
  }

  async setNotifyPrefs(userId: string, patch: NotifyPrefs): Promise<NotifyPrefs> {
    const set: { notifyMuted?: boolean; notifyCompact?: boolean } = {};
    if (patch.muted !== undefined) set.notifyMuted = patch.muted;
    if (patch.compact !== undefined) set.notifyCompact = patch.compact;
    if (Object.keys(set).length > 0) {
      await this.db.update(schema.users).set(set).where(eq(schema.users.id, userId));
    }
    return this.getNotifyPrefs(userId);
  }

  async getOrMintReferralCode(userId: string): Promise<string> {
    const existing = await this.db
      .select({ code: schema.referrals.code })
      .from(schema.referrals)
      .where(eq(schema.referrals.ownerUserId, userId))
      .limit(1);
    const found = existing[0];
    if (found) return found.code;
    // 6 random bytes → 8 chars base64url — unguessable, URL-safe, short.
    const { randomBytes } = await import('node:crypto');
    const code = randomBytes(6).toString('base64url').slice(0, 8);
    const [inserted] = await this.db
      .insert(schema.referrals)
      .values({ code, ownerUserId: userId })
      .onConflictDoNothing({ target: schema.referrals.ownerUserId })
      .returning({ code: schema.referrals.code });
    if (inserted) return inserted.code;
    // Raced with another writer for the same user — re-read.
    const after = await this.db
      .select({ code: schema.referrals.code })
      .from(schema.referrals)
      .where(eq(schema.referrals.ownerUserId, userId))
      .limit(1);
    const ref = after[0];
    if (!ref) throw new Error(`getOrMintReferralCode: insert and re-read both empty for ${userId}`);
    return ref.code;
  }

  async findReferrerByCode(code: string): Promise<{ readonly userId: string } | null> {
    const rows = await this.db
      .select({ userId: schema.referrals.ownerUserId })
      .from(schema.referrals)
      .where(eq(schema.referrals.code, code.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordReferralAttribution(
    referredUserId: string,
    code: string,
  ): Promise<{
    readonly kind: 'attributed' | 'already_attributed';
    readonly referrerUserId: string;
  }> {
    const c = code.toLowerCase();
    const referrer = await this.findReferrerByCode(c);
    if (!referrer) throw new Error(`unknown referral code ${c}`);
    const [inserted] = await this.db
      .insert(schema.referralsAttribution)
      .values({ referredUserId, code: c })
      .onConflictDoNothing({ target: schema.referralsAttribution.referredUserId })
      .returning({ code: schema.referralsAttribution.code });
    if (inserted) return { kind: 'attributed', referrerUserId: referrer.userId };
    const existing = await this.db
      .select({ code: schema.referralsAttribution.code })
      .from(schema.referralsAttribution)
      .where(eq(schema.referralsAttribution.referredUserId, referredUserId))
      .limit(1);
    const found = existing[0];
    if (!found) {
      throw new Error(`recordReferralAttribution: conflict but no row for ${referredUserId}`);
    }
    const owner = await this.findReferrerByCode(found.code);
    return { kind: 'already_attributed', referrerUserId: owner?.userId ?? referrer.userId };
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

  async listFillsForUser(userId: string, limit: number): Promise<readonly PnlFill[]> {
    const rows = await this.db
      .select({
        wallet: schema.fills.wallet,
        coin: schema.fills.coin,
        side: schema.fills.side,
        px: schema.fills.px,
        sz: schema.fills.sz,
        notionalUsd: schema.fills.notionalUsd,
        builderFeeUsd: schema.fills.builderFeeUsd,
        builderFeeTenthsBp: schema.fills.builderFeeTenthsBp,
        realizedPnlUsd: schema.fills.realizedPnlUsd,
        ts: schema.fills.ts,
        alias: schema.whales.alias,
      })
      .from(schema.fills)
      .leftJoin(schema.whales, eq(schema.whales.address, schema.fills.wallet))
      .where(
        and(
          eq(schema.fills.userId, userId),
          eq(schema.fills.isMirror, true),
          isNotNull(schema.fills.builderFeeUsd),
        ),
      )
      .orderBy(desc(schema.fills.ts))
      .limit(limit);
    return rows.map((r) => {
      const fill: PnlFill = {
        whaleAddress: r.wallet as `0x${string}`,
        coin: r.coin,
        side: r.side as 'B' | 'S',
        px: r.px,
        sz: r.sz,
        notionalUsd: r.notionalUsd,
        builderFeeUsd: r.builderFeeUsd ?? '0',
        builderFeeTenthsBp: r.builderFeeTenthsBp ?? 0,
        ts: Math.floor(r.ts.getTime() / 1000),
        ...(r.alias !== null ? { whaleAlias: r.alias } : {}),
        ...(r.realizedPnlUsd !== null ? { realizedPnlUsd: r.realizedPnlUsd } : {}),
      };
      return fill;
    });
  }

  // Leaderboard prefers true closed-leg P&L from `realized_pnl_usd` when the
  // fill has it; for legacy rows where it is NULL we fall back to a sign-
  // adjusted notional proxy so older mirrors still contribute.
  async listLeaderboard(limit: number): Promise<readonly LeaderboardEntry[]> {
    const rows = await this.db
      .select({
        userId: schema.fills.userId,
        tgUsername: schema.users.tgUsername,
        mainWallet: schema.users.mainWallet,
        net: sql<string>`SUM(COALESCE(${schema.fills.realizedPnlUsd}, CASE WHEN ${schema.fills.side} = 'B' THEN -${schema.fills.notionalUsd} ELSE ${schema.fills.notionalUsd} END))`,
      })
      .from(schema.fills)
      .innerJoin(schema.users, eq(schema.users.id, schema.fills.userId))
      .where(and(eq(schema.fills.isMirror, true), isNotNull(schema.fills.userId)))
      .groupBy(schema.fills.userId, schema.users.tgUsername, schema.users.mainWallet)
      .limit(limit);
    const entries: LeaderboardEntry[] = [];
    for (const r of rows) {
      if (r.userId === null) continue;
      const handle =
        r.tgUsername !== null && r.tgUsername.length > 0
          ? `@${r.tgUsername}`
          : `${r.mainWallet.slice(0, 6)}…${r.mainWallet.slice(-4)}`;
      entries.push({
        userId: r.userId,
        handle,
        realizedPnlUsd: Number(r.net),
      });
    }
    return entries;
  }
}
