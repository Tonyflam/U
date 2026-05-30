/**
 * Postgres-backed implementations of `SubscriberLookup` and a whale-list
 * provider used to drive the WS subscription set.
 *
 * Production wiring: ws-consumer queries these on every fill (for the
 * subscriber list) and periodically (for the whale set refresh).
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, type AnyDb } from '@whalepod/schema';
import type { SubscriberLookup } from './consumer.js';
import type { Subscriber } from './fanout.js';

const { subscriptions, users, whales } = schema;

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
 * Returns the list of whale addresses we should subscribe to. Currently:
 * any whale that has at least one non-paused subscription. Polled from
 * `start.ts` on an interval — cheap query under the unique index.
 */
export async function fetchActiveWhaleAddresses(db: AnyDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: whales.address })
    .from(whales)
    .innerJoin(subscriptions, eq(subscriptions.whaleId, whales.id))
    .where(sql`${subscriptions.paused} = false`);
  return rows.map((r) => r.address);
}
