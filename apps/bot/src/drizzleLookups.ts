/**
 * Drizzle-backed lookups consumed by the trading hot path:
 *
 *  - `DrizzleUserAddressLookup` resolves a user's main wallet (for HL
 *    `clearinghouseState` queries via `HlInfoEquity`).
 *  - `DrizzleAgentKeyLookup` returns the sealed agent key envelope so
 *    `KmsAgentSigner` can derive a per-signature ephemeral signer.
 *
 * Both query `schema.users` by primary-key uuid and return `undefined`
 * (not throw) on miss. Callers turn that into a domain error.
 */
import { eq } from 'drizzle-orm';
import { schema, type AnyDb, type Address } from '@whalepod/schema';
import type { SealedAgentKey } from '@whalepod/vault';
import type { UserAddressLookup } from './hlInfoEquity.js';
import type { AgentKeyLookup, AgentKeyRow } from './kmsAgentSigner.js';
import type { TgUserIdResolver } from './fillPublisher.js';
import type { NotifyPrefs } from './notify.js';
import type { NotifyPrefsResolver } from './notifyConsumer.js';

export class DrizzleTgUserIdResolver implements TgUserIdResolver {
  constructor(private readonly db: AnyDb) {}

  async tgUserIdByUserId(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ tgUserId: schema.users.tgUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    return row ? row.tgUserId.toString() : null;
  }
}

export class DrizzleNotifyPrefsResolver implements NotifyPrefsResolver {
  constructor(private readonly db: AnyDb) {}

  async prefsByTgUserId(tgUserId: string): Promise<NotifyPrefs | null> {
    let parsed: bigint;
    try {
      parsed = BigInt(tgUserId);
    } catch {
      return null;
    }
    const rows = await this.db
      .select({
        muted: schema.users.notifyMuted,
        compact: schema.users.notifyCompact,
      })
      .from(schema.users)
      .where(eq(schema.users.tgUserId, parsed))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { muted: row.muted, compact: row.compact };
  }
}

export class DrizzleUserAddressLookup implements UserAddressLookup {
  constructor(private readonly db: AnyDb) {}

  async mainWalletFor(userId: string): Promise<Address | undefined> {
    const rows = await this.db
      .select({ mainWallet: schema.users.mainWallet })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    return row ? row.mainWallet : undefined;
  }
}

export class DrizzleAgentKeyLookup implements AgentKeyLookup {
  constructor(private readonly db: AnyDb) {}

  async forUser(userId: string): Promise<AgentKeyRow | undefined> {
    const rows = await this.db
      .select({
        ct: schema.users.agentKeyCt,
        iv: schema.users.agentKeyIv,
        tag: schema.users.agentKeyTag,
        dekCt: schema.users.agentDekCt,
        mainWallet: schema.users.mainWallet,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const sealed: SealedAgentKey = {
      ct: toUint8(row.ct),
      iv: toUint8(row.iv),
      tag: toUint8(row.tag),
      dekCt: toUint8(row.dekCt),
    };
    return { sealed, mainWallet: row.mainWallet };
  }
}

function toUint8(b: Uint8Array | Buffer): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}
