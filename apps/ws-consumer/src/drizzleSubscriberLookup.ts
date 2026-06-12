/**
 * Postgres-backed implementations of `SubscriberLookup` and a whale-list
 * provider used to drive the WS subscription set.
 *
 * Production wiring: ws-consumer queries these on every fill (for the
 * subscriber list) and periodically (for the whale set refresh).
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, type AnyDb } from '@whalepod/schema';
import type { SubscriberLookup, WatcherLookup } from './consumer.js';
import type { Subscriber } from './fanout.js';

const { subscriptions, users, watches, whales } = schema;

export class DrizzleSubscriberLookup implements SubscriberLookup {
  constructor(private readonly db: AnyDb) {}

  async subscribersFor(whaleAddress: string): Promise<readonly Subscriber[]> {
    const addr = whaleAddress.toLowerCase();
    const rows = await this.db
      .select({
        id: users.id,
        whaleAddress: whales.address,
        paused: subscriptions.paused,
        killSwitch: users.killSwitch,
        revokedAt: users.revokedAt,
      })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .innerJoin(whales, eq(whales.id, subscriptions.whaleId))
      .where(and(eq(whales.address, addr), eq(subscriptions.paused, false)));
    return rows
      .filter((r) => r.revokedAt === null)
      .map((r) => ({
        id: r.id,
        whaleAddress: r.whaleAddress,
        paused: r.paused,
        killSwitch: r.killSwitch,
      }));
  }
}

/**
 * Postgres-backed `WatcherLookup`: Telegram user ids watching a whale
 * (zero-trust /watch alerts — watchers have no `users` row). The whale
 * alias rides along for friendly alert copy.
 */
export class DrizzleWatcherLookup implements WatcherLookup {
  constructor(private readonly db: AnyDb) {}

  async watchersFor(whaleAddress: string): Promise<{
    readonly tgUserIds: readonly string[];
    readonly whaleAlias: string | null;
  }> {
    const addr = whaleAddress.toLowerCase();
    const rows = await this.db
      .select({
        tgUserId: watches.tgUserId,
        alias: whales.alias,
      })
      .from(watches)
      .innerJoin(whales, eq(whales.id, watches.whaleId))
      .where(eq(whales.address, addr));
    return {
      tgUserIds: rows.map((r) => r.tgUserId.toString()),
      whaleAlias: rows[0]?.alias ?? null,
    };
  }
}

/**
 * Returns the list of whale addresses we should subscribe to. Currently:
 * any whale that has at least one non-paused subscription OR at least one
 * watcher. Polled from `start.ts` on an interval — cheap queries under
 * their respective indexes.
 */
export async function fetchActiveWhaleAddresses(db: AnyDb): Promise<string[]> {
  const [mirrored, watched] = await Promise.all([
    db
      .selectDistinct({ address: whales.address })
      .from(whales)
      .innerJoin(subscriptions, eq(subscriptions.whaleId, whales.id))
      .where(sql`${subscriptions.paused} = false`),
    db
      .selectDistinct({ address: whales.address })
      .from(whales)
      .innerJoin(watches, eq(watches.whaleId, whales.id)),
  ]);
  const out = new Set<string>();
  for (const r of mirrored) out.add(r.address);
  for (const r of watched) out.add(r.address);
  return [...out];
}
