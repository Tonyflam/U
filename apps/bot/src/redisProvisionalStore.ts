/**
 * Upstash Redis-backed `ProvisionalStore`.
 *
 * Used by the miniapp onboarding flow (U7): the partial onboarding row is
 * held under a TTL'd key until the user countersigns both EIP-712 payloads
 * and we finalize into Postgres.
 *
 * Why Upstash (HTTP) not native Redis: edge-friendly, no connection pooling
 * concerns on Vercel/Fly. Latency is fine for this path (one read + one
 * write per onboarding).
 *
 * Key format: `prov:{id}` where id is a UUID issued by the miniapp.
 * TTL: 15 minutes — long enough for a slow wallet signing flow, short
 * enough that a leaked id is dead before it matters.
 *
 * Serialization: ProvisionalRow contains Uint8Array members (sealed agent
 * key). Redis stores strings, so we base64-encode bytes on write and decode
 * on read. JSON.stringify can't handle bigint, so tgUserId rides as a
 * decimal string.
 */
import type { Redis } from '@upstash/redis';
import type { ProvisionalRow } from '@whalepod/miniapp';
import type { ProvisionalStore } from './onboardRepo.js';

const KEY_PREFIX = 'prov:';
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface RedisProvisionalStoreOptions {
  readonly redis: Redis;
  readonly ttlSeconds?: number;
}

interface SerializedRow {
  readonly id: string;
  readonly tgUserId: string;
  readonly tgUsername: string | null;
  readonly mainWallet: string;
  readonly agentAddress: string;
  readonly sealed: {
    readonly ct: string;
    readonly iv: string;
    readonly tag: string;
    readonly dekCt: string;
  };
  readonly approvedMaxFeeTenthsBp: number;
  readonly currentFeeTenthsBp: number;
  readonly equityFloorUsd: string;
  readonly approveAgentAction: unknown;
  readonly approveBuilderFeeAction: unknown;
}

function b64encode(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function serialize(row: ProvisionalRow): SerializedRow {
  return {
    id: row.id,
    tgUserId: row.tgUserId.toString(),
    tgUsername: row.tgUsername,
    mainWallet: row.mainWallet,
    agentAddress: row.agentAddress,
    sealed: {
      ct: b64encode(row.sealed.ct),
      iv: b64encode(row.sealed.iv),
      tag: b64encode(row.sealed.tag),
      dekCt: b64encode(row.sealed.dekCt),
    },
    approvedMaxFeeTenthsBp: row.approvedMaxFeeTenthsBp,
    currentFeeTenthsBp: row.currentFeeTenthsBp,
    equityFloorUsd: row.equityFloorUsd,
    approveAgentAction: row.approveAgentAction,
    approveBuilderFeeAction: row.approveBuilderFeeAction,
  };
}

function deserialize(s: SerializedRow): ProvisionalRow {
  return {
    id: s.id,
    tgUserId: BigInt(s.tgUserId),
    tgUsername: s.tgUsername,
    mainWallet: s.mainWallet,
    agentAddress: s.agentAddress,
    sealed: {
      ct: b64decode(s.sealed.ct),
      iv: b64decode(s.sealed.iv),
      tag: b64decode(s.sealed.tag),
      dekCt: b64decode(s.sealed.dekCt),
    },
    approvedMaxFeeTenthsBp: s.approvedMaxFeeTenthsBp,
    currentFeeTenthsBp: s.currentFeeTenthsBp,
    equityFloorUsd: s.equityFloorUsd,
    // The action payloads are validated by zod at the boundary in
    // onboardSchema; here we trust the round-trip.
    approveAgentAction: s.approveAgentAction as ProvisionalRow['approveAgentAction'],
    approveBuilderFeeAction: s.approveBuilderFeeAction as ProvisionalRow['approveBuilderFeeAction'],
  };
}

export class RedisProvisionalStore implements ProvisionalStore {
  private readonly redis: Redis;
  private readonly ttl: number;

  constructor(options: RedisProvisionalStoreOptions) {
    this.redis = options.redis;
    this.ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async put(row: ProvisionalRow): Promise<void> {
    await this.redis.set(KEY_PREFIX + row.id, serialize(row), { ex: this.ttl });
  }

  async get(id: string): Promise<ProvisionalRow | null> {
    const raw = await this.redis.get<SerializedRow>(KEY_PREFIX + id);
    return raw ? deserialize(raw) : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + id);
  }
}
