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
import { verifyTypedData } from 'viem';
import { Address } from '@whalepod/schema';
import { KmsClient } from '@whalepod/config';
import { type OnboardDeps, type OnboardRepo, type ProvisionalRow } from '@whalepod/miniapp';

class InMemoryOnboardRepo implements OnboardRepo {
  private readonly rows = new Map<string, ProvisionalRow>();
  private readonly users = new Map<string, { userId: string }>();
  async putProvisional(row: ProvisionalRow): Promise<void> {
    this.rows.set(row.id, row);
  }
  async getProvisional(id: string): Promise<ProvisionalRow | null> {
    return this.rows.get(id) ?? null;
  }
  async finalize(
    provisionalId: string,
    _sigs: { approveAgentSig: `0x${string}`; approveBuilderFeeSig: `0x${string}` },
  ): Promise<{ userId: string }> {
    const existing = this.users.get(provisionalId);
    if (existing) return existing;
    const userId = crypto.randomUUID();
    this.users.set(provisionalId, { userId });
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
  if (!awsRegion) throw new Error('AWS_REGION required');
  if (!cmkArn) throw new Error('VAULT_KMS_CMK_ARN required');
  if (!builderAddrRaw) throw new Error('BUILDER_ADDRESS required');
  const builderAddress = Address.parse(builderAddrRaw);

  const kms = new KmsClient({ region: awsRegion, keyId: cmkArn });

  cached = {
    repo: new InMemoryOnboardRepo(),
    kms,
    builderAddress,
    chain,
    agentName,
    verifyTypedData: async (args) => verifyTypedData(args),
  };
  return cached;
}
