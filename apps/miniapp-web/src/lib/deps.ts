/**
 * Server-only dependency builder for the onboarding API routes.
 *
 * Constructs and caches `OnboardDeps` (KMS client, in-memory or pg repo,
 * builder address, chain). Imported only from `app/api/**` route handlers
 * — never from a client component.
 *
 * Repo: this shell ships with an in-memory provisional store so the app
 * runs without a database for the U26 surface. Production wires this to
 * `RedisProvisionalStore` + Postgres `finalize` in a later integration step.
 */
import 'server-only';
import { Redis } from '@upstash/redis';
import { verifyTypedData } from 'viem';
import { Address } from '@whalepod/schema';
import { KmsClient } from '@whalepod/config';
import { type OnboardDeps, type OnboardRepo, type ProvisionalRow } from '@whalepod/miniapp';

const PROVISIONAL_TTL_SECONDS = 600;

function encodeRow(row: ProvisionalRow): string {
  return JSON.stringify(row, (_k, v: unknown) => {
    if (typeof v === 'bigint') return { __bigint: v.toString() };
    if (v instanceof Uint8Array) {
      return { __u8: Buffer.from(v).toString('base64') };
    }
    return v;
  });
}

function decodeRow(s: string): ProvisionalRow {
  return JSON.parse(s, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['__bigint'] === 'string') return BigInt(o['__bigint']);
      if (typeof o['__u8'] === 'string')
        return new Uint8Array(Buffer.from(o['__u8'], 'base64'));
    }
    return v;
  }) as ProvisionalRow;
}

class RedisOnboardRepo implements OnboardRepo {
  constructor(private readonly redis: Redis) {}
  async putProvisional(row: ProvisionalRow): Promise<void> {
    await this.redis.set(`onboard:prov:${row.id}`, encodeRow(row), {
      ex: PROVISIONAL_TTL_SECONDS,
    });
  }
  async getProvisional(id: string): Promise<ProvisionalRow | null> {
    const raw = await this.redis.get<string>(`onboard:prov:${id}`);
    if (!raw) return null;
    if (typeof raw !== 'string') {
      // Upstash auto-parses JSON sometimes; re-stringify.
      return decodeRow(JSON.stringify(raw));
    }
    return decodeRow(raw);
  }
  async finalize(
    provisionalId: string,
    _sigs: { approveAgentSig: `0x${string}`; approveBuilderFeeSig: `0x${string}` },
  ): Promise<{ userId: string }> {
    const key = `onboard:user:${provisionalId}`;
    const existing = await this.redis.get<string>(key);
    if (typeof existing === 'string' && existing) return { userId: existing };
    const userId = crypto.randomUUID();
    await this.redis.set(key, userId, { ex: 86400 });
    return { userId };
  }
}

let cached: OnboardDeps | undefined;

export function getOnboardDeps(): OnboardDeps {
  if (cached) return cached;
  const awsRegion = process.env['AWS_REGION'];
  const cmkArn = process.env['VAULT_KMS_CMK_ARN'];
  const builderAddrRaw = process.env['BUILDER_ADDRESS'];
  const chain = process.env['HL_CHAIN'] === 'Mainnet' ? 'Mainnet' : 'Testnet';
  const agentName = process.env['AGENT_NAME'] ?? 'WhalePod';
  const redisUrl = process.env['UPSTASH_REDIS_REST_URL'];
  const redisToken = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!awsRegion) throw new Error('AWS_REGION required');
  if (!cmkArn) throw new Error('VAULT_KMS_CMK_ARN required');
  if (!builderAddrRaw) throw new Error('BUILDER_ADDRESS required');
  if (!redisUrl) throw new Error('UPSTASH_REDIS_REST_URL required');
  if (!redisToken) throw new Error('UPSTASH_REDIS_REST_TOKEN required');
  const builderAddress = Address.parse(builderAddrRaw);

  const kms = new KmsClient({ region: awsRegion, keyId: cmkArn });
  const redis = new Redis({ url: redisUrl, token: redisToken });

  cached = {
    repo: new RedisOnboardRepo(redis),
    kms,
    builderAddress,
    chain,
    agentName,
    verifyTypedData: async (args) => verifyTypedData(args),
  };
  return cached;
}
