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
import { eq } from 'drizzle-orm';
import { Address, createDb, schema, type Db } from '@whalepod/schema';
import { KmsClient } from '@whalepod/config';
import { HttpHlTransport, hlBaseUrl } from '@whalepod/sdk';
import {
  type ExchangeSubmitter,
  type OnboardDeps,
  type OnboardRepo,
  type ProvisionalRow,
} from '@whalepod/miniapp';

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
      if (typeof o['__u8'] === 'string') return new Uint8Array(Buffer.from(o['__u8'], 'base64'));
    }
    return v;
  }) as ProvisionalRow;
}

class HybridOnboardRepo implements OnboardRepo {
  constructor(
    private readonly redis: Redis,
    private readonly db: Db,
  ) {}
  async putProvisional(row: ProvisionalRow): Promise<void> {
    await this.redis.set(`onboard:prov:${row.id}`, encodeRow(row), {
      ex: PROVISIONAL_TTL_SECONDS,
    });
  }
  async getProvisional(id: string): Promise<ProvisionalRow | null> {
    const raw = await this.redis.get<string>(`onboard:prov:${id}`);
    if (!raw) return null;
    if (typeof raw !== 'string') return decodeRow(JSON.stringify(raw));
    return decodeRow(raw);
  }
  async finalize(
    provisionalId: string,
    _sigs: { approveAgentSig: `0x${string}`; approveBuilderFeeSig: `0x${string}` },
  ): Promise<{ userId: string }> {
    const prov = await this.getProvisional(provisionalId);
    if (!prov) throw new Error(`provisional row missing during finalize: ${provisionalId}`);

    const existing = await this.db
      .select({ id: schema.users.id, revokedAt: schema.users.revokedAt })
      .from(schema.users)
      .where(eq(schema.users.tgUserId, prov.tgUserId))
      .limit(1);
    if (existing[0]) {
      // Re-onboard: overwrite wallet/agent/sealed key, clear revocation + kill.
      await this.db
        .update(schema.users)
        .set({
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
          killSwitch: false,
        })
        .where(eq(schema.users.id, existing[0].id));
      await this.redis.del(`onboard:prov:${provisionalId}`);
      return { userId: existing[0].id };
    }

    const inserted = await this.db
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
      .returning({ id: schema.users.id });

    await this.redis.del(`onboard:prov:${provisionalId}`);
    return { userId: inserted[0]!.id };
  }
}

let cached: OnboardDeps | undefined;

export function getOnboardDeps(): OnboardDeps {
  if (cached) return cached;
  const awsRegion = process.env['AWS_REGION'];
  const cmkArn = process.env['VAULT_KMS_CMK_ARN'];
  const builderAddrRaw = process.env['BUILDER_ADDRESS'];
  // Accept HL_CHAIN=Mainnet|Testnet (server) OR HL_NETWORK / NEXT_PUBLIC_HL_NETWORK = mainnet|testnet.
  // Onboarding default is Mainnet — testnet must be opted into explicitly.
  const chainRaw = (
    process.env['HL_CHAIN'] ??
    process.env['HL_NETWORK'] ??
    process.env['NEXT_PUBLIC_HL_NETWORK'] ??
    'Mainnet'
  ).toLowerCase();
  const chain: 'Mainnet' | 'Testnet' = chainRaw === 'testnet' ? 'Testnet' : 'Mainnet';
  const agentName = process.env['AGENT_NAME'] ?? 'WhalePod';
  const redisUrl = process.env['UPSTASH_REDIS_REST_URL'];
  const redisToken = process.env['UPSTASH_REDIS_REST_TOKEN'];
  const databaseUrl = process.env['DATABASE_URL'];
  const databaseSsl = (process.env['DATABASE_SSL'] ?? 'require') as
    | 'require'
    | 'prefer'
    | 'disable';
  if (!awsRegion) throw new Error('AWS_REGION required');
  if (!cmkArn) throw new Error('VAULT_KMS_CMK_ARN required');
  if (!builderAddrRaw) throw new Error('BUILDER_ADDRESS required');
  if (!redisUrl) throw new Error('UPSTASH_REDIS_REST_URL required');
  if (!redisToken) throw new Error('UPSTASH_REDIS_REST_TOKEN required');
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  const builderAddress = Address.parse(builderAddrRaw);

  const kms = new KmsClient({ region: awsRegion, keyId: cmkArn });
  const redis = new Redis({ url: redisUrl, token: redisToken });
  const { db } = createDb({ url: databaseUrl, ssl: databaseSsl, max: 1 });

  const hlBaseUrlResolved =
    process.env['HL_API_URL'] ?? hlBaseUrl(chain === 'Mainnet' ? 'mainnet' : 'testnet');
  const transport = new HttpHlTransport({ baseUrl: hlBaseUrlResolved });
  const submitExchange: ExchangeSubmitter = {
    submit: async ({ action, signatureHex, nonce }) => {
      if (signatureHex.length !== 132) {
        throw new Error(`bad signature length: ${String(signatureHex.length)}`);
      }
      const r = `0x${signatureHex.slice(2, 66)}` as `0x${string}`;
      const s = `0x${signatureHex.slice(66, 130)}` as `0x${string}`;
      const v = Number.parseInt(signatureHex.slice(130, 132), 16);
      await transport.exchange({ action, signature: { r, s, v }, nonce });
    },
  };

  // Pre-flight used by the onboard `start` handler: is this wallet activated on
  // Hyperliquid? HL refuses approveAgent until the account exists (first
  // deposit). We treat the wallet as funded if it has perps equity, any spot
  // balance, or any ledger history (covers deposited-then-withdrew). If every
  // probe fails (HL info outage) we throw so the caller falls through to the
  // authoritative /exchange submission instead of false-blocking onboarding.
  const checkAccountFunded = async (mainWallet: string): Promise<boolean> => {
    const user = mainWallet.toLowerCase();
    const settled = await Promise.allSettled([
      transport.info<{ marginSummary?: { accountValue?: string } }>({
        type: 'clearinghouseState',
        user,
      }),
      transport.info<{ balances?: unknown[] }>({ type: 'spotClearinghouseState', user }),
      transport.info<unknown[]>({ type: 'userNonFundingLedgerUpdates', user }),
    ]);
    if (settled.every((res) => res.status === 'rejected')) {
      throw new Error('HL info unavailable for funded-check');
    }
    const perp = settled[0].status === 'fulfilled' ? settled[0].value : undefined;
    const spot = settled[1].status === 'fulfilled' ? settled[1].value : undefined;
    const ledger = settled[2].status === 'fulfilled' ? settled[2].value : undefined;
    const equity = Number(perp?.marginSummary?.accountValue ?? '0');
    const spotBalances = spot?.balances;
    const hasSpot = Array.isArray(spotBalances) && spotBalances.length > 0;
    const hasLedger = Array.isArray(ledger) && ledger.length > 0;
    return equity > 0 || hasSpot || hasLedger;
  };

  cached = {
    repo: new HybridOnboardRepo(redis, db),
    kms,
    builderAddress,
    chain,
    agentName,
    verifyTypedData: async (args) => verifyTypedData(args),
    submitExchange,
    checkAccountFunded,
  };
  return cached;
}
