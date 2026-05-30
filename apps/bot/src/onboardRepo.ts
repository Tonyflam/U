/**
 * Drizzle-backed implementation of `OnboardRepo` from @whalepod/miniapp.
 *
 * Two-row dance: a `provisional` row is held in memory (Redis in prod) until
 * the user's wallet has countersigned both EIP-712 payloads; finalization
 * flips it into a permanent `users` row. We intentionally do NOT persist the
 * partial state to Postgres — a user who abandons mid-flow leaves no DB
 * trace, and a leaked provisional id can never be redeemed past TTL.
 *
 * In-memory `Map` is used for the local dev case; production wires Upstash
 * Redis (see `RedisProvisionalStore`).
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@whalepod/schema';
import type { OnboardRepo, ProvisionalRow } from '@whalepod/miniapp';

export interface ProvisionalStore {
  put(row: ProvisionalRow): Promise<void>;
  get(id: string): Promise<ProvisionalRow | null>;
  delete(id: string): Promise<void>;
}

/** In-process store for local dev / tests. NOT for production. */
export class InMemoryProvisionalStore implements ProvisionalStore {
  private readonly rows = new Map<string, ProvisionalRow>();
  // eslint-disable-next-line @typescript-eslint/require-await
  async put(row: ProvisionalRow): Promise<void> {
    this.rows.set(row.id, row);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string): Promise<ProvisionalRow | null> {
    return this.rows.get(id) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export interface DrizzleOnboardRepoDeps {
  readonly db: Db;
  readonly store: ProvisionalStore;
}

export class DrizzleOnboardRepo implements OnboardRepo {
  constructor(private readonly deps: DrizzleOnboardRepoDeps) {}

  async putProvisional(row: ProvisionalRow): Promise<void> {
    await this.deps.store.put(row);
  }

  async getProvisional(id: string): Promise<ProvisionalRow | null> {
    return this.deps.store.get(id);
  }

  async finalize(
    provisionalId: string,
    // We intentionally don't persist the wallet signatures themselves —
    // they're proof-of-life for THIS onboarding; HL stores the on-chain
    // approval. Keeping them only invites replay-grade incidents.
    _sigs: { approveAgentSig: `0x${string}`; approveBuilderFeeSig: `0x${string}` },
  ): Promise<{ userId: string }> {
    const prov = await this.deps.store.get(provisionalId);
    if (!prov) {
      throw new Error(`provisional ${provisionalId} not found at finalize`);
    }
    const [inserted] = await this.deps.db
      .insert(schema.users)
      .values({
        tgUserId: prov.tgUserId,
        tgUsername: prov.tgUsername,
        mainWallet: prov.mainWallet,
        agentAddress: prov.agentAddress,
        agentKeyCt: prov.sealed.ct,
        agentKeyIv: prov.sealed.iv,
        agentKeyTag: prov.sealed.tag,
        agentDekCt: prov.sealed.dekCt,
        approvedMaxFeeTenthsBp: prov.approvedMaxFeeTenthsBp,
        currentFeeTenthsBp: prov.currentFeeTenthsBp,
        equityFloorUsd: prov.equityFloorUsd,
      })
      .onConflictDoUpdate({
        target: schema.users.tgUserId,
        set: {
          tgUsername: prov.tgUsername,
          mainWallet: prov.mainWallet,
          agentAddress: prov.agentAddress,
          agentKeyCt: prov.sealed.ct,
          agentKeyIv: prov.sealed.iv,
          agentKeyTag: prov.sealed.tag,
          agentDekCt: prov.sealed.dekCt,
          approvedMaxFeeTenthsBp: prov.approvedMaxFeeTenthsBp,
          currentFeeTenthsBp: prov.currentFeeTenthsBp,
          equityFloorUsd: prov.equityFloorUsd,
          revokedAt: null,
        },
      })
      .returning({ id: schema.users.id });
    if (!inserted) {
      throw new Error(`finalize for ${provisionalId} returned no row`);
    }
    await this.deps.store.delete(provisionalId);
    return { userId: inserted.id };
  }
}

/** Lookup a user by Telegram user id (for command handlers). */
export async function getUserByTgId(
  db: Db,
  tgUserId: bigint,
): Promise<typeof schema.users.$inferSelect | null> {
  const rows = await db.select().from(schema.users).where(eq(schema.users.tgUserId, tgUserId));
  return rows[0] ?? null;
}
