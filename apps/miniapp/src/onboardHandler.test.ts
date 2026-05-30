import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { VaultKms } from '@whalepod/vault';
import {
  OnboardError,
  onboardCompleteHandler,
  onboardStartHandler,
  type OnboardDeps,
  type OnboardRepo,
  type ProvisionalRow,
  type VerifyTypedDataFn,
} from './onboardHandler.js';

// Minimal in-process KMS for tests — round-trips DEK ciphertext only.
class TestKms implements VaultKms {
  private readonly root = randomBytes(32);
  // eslint-disable-next-line @typescript-eslint/require-await
  async generateDataKey() {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.root, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      plaintext: new Uint8Array(plaintext),
      ciphertext: new Uint8Array(Buffer.concat([iv, tag, ct])),
    };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async decrypt(blob: Uint8Array) {
    const buf = Buffer.from(blob);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const dec = createDecipheriv('aes-256-gcm', this.root, iv);
    dec.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([dec.update(ct), dec.final()]));
  }
}

const WALLET = '0x1111222233334444555566667777888899990000';
const AGENT = '0xaaaa222233334444555566667777888899990000';
const BUILDER = '0x2222333344445555666677778888999900001111';

function memRepo(): OnboardRepo & { rows: Map<string, ProvisionalRow>; finalized: string[] } {
  const rows = new Map<string, ProvisionalRow>();
  const finalized: string[] = [];
  return {
    rows,
    finalized,
    // eslint-disable-next-line @typescript-eslint/require-await
    async putProvisional(row) {
      rows.set(row.id, row);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async getProvisional(id) {
      return rows.get(id) ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async finalize(provisionalId) {
      finalized.push(provisionalId);
      return { userId: `user-${provisionalId}` };
    },
  };
}

function depsWith(
  overrides: Partial<OnboardDeps> = {},
): OnboardDeps & { repo: ReturnType<typeof memRepo> } {
  const repo = overrides.repo ? (overrides.repo as ReturnType<typeof memRepo>) : memRepo();
  const verifyTypedData: VerifyTypedDataFn =
    overrides.verifyTypedData ??
    // eslint-disable-next-line @typescript-eslint/require-await
    (async () => true);
  const base: OnboardDeps = {
    repo,
    kms: new TestKms(),
    builderAddress: BUILDER,
    chain: 'Testnet',
    agentName: 'WhalePod',
    now: () => 1_700_000_000_000,
    newId: () => '00000000-0000-0000-0000-000000000001',
    generateAgentKey: () => ({
      address: AGENT,
      privateKey: new Uint8Array(32).fill(7),
    }),
    verifyTypedData,
  };
  return { ...base, ...overrides, repo, verifyTypedData };
}

const startBody = {
  tgUserId: 12345n,
  tgUsername: 'alice',
  mainWallet: WALLET,
  equityFloorUsd: '100.00',
  approvedMaxFeeTenthsBp: 50,
};

describe('onboardStartHandler', () => {
  it('returns the agent address and signed-payload templates', async () => {
    const deps = depsWith();
    const res = await onboardStartHandler(startBody, deps);
    expect(res.provisionalId).toBe('00000000-0000-0000-0000-000000000001');
    expect(res.agentAddress).toBe(AGENT);
    expect(res.approveAgent.action.type).toBe('approveAgent');
    expect(res.approveAgent.action.agentAddress).toBe(AGENT);
    expect(res.approveAgent.typedData.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(res.approveBuilderFee.action.type).toBe('approveBuilderFee');
    expect(res.approveBuilderFee.action.maxFeeRate).toBe('0.0500%');
  });

  it('uses distinct nonces for the two approvals', async () => {
    const deps = depsWith();
    const res = await onboardStartHandler(startBody, deps);
    expect(res.approveAgent.action.nonce).not.toBe(res.approveBuilderFee.action.nonce);
  });

  it('persists a provisional row containing the sealed agent key', async () => {
    const deps = depsWith();
    await onboardStartHandler(startBody, deps);
    const row = deps.repo.rows.get('00000000-0000-0000-0000-000000000001');
    expect(row).toBeDefined();
    expect(row?.sealed.ct.length).toBeGreaterThan(0);
    expect(row?.sealed.dekCt.length).toBeGreaterThan(0);
    expect(row?.mainWallet).toBe(WALLET);
    expect(row?.agentAddress).toBe(AGENT);
    expect(row?.approvedMaxFeeTenthsBp).toBe(50);
  });

  it('clamps currentFeeTenthsBp to the DEFAULT when approved is higher', async () => {
    const deps = depsWith();
    await onboardStartHandler({ ...startBody, approvedMaxFeeTenthsBp: 100 }, deps);
    const row = deps.repo.rows.get('00000000-0000-0000-0000-000000000001');
    expect(row?.currentFeeTenthsBp).toBe(50);
  });

  it('rejects an invalid request body', async () => {
    const deps = depsWith();
    await expect(
      onboardStartHandler({ ...startBody, mainWallet: 'nope' }, deps),
    ).rejects.toBeInstanceOf(OnboardError);
  });
});

describe('onboardCompleteHandler', () => {
  it('finalizes when both signatures verify against mainWallet', async () => {
    const deps = depsWith();
    await onboardStartHandler(startBody, deps);
    const out = await onboardCompleteHandler(
      {
        provisionalId: '00000000-0000-0000-0000-000000000001',
        approveAgentSig: '0xaa',
        approveBuilderFeeSig: '0xbb',
      },
      deps,
    );
    expect(out.userId).toBe('user-00000000-0000-0000-0000-000000000001');
    expect(deps.repo.finalized).toContain('00000000-0000-0000-0000-000000000001');
  });

  it('rejects when either signature fails verification', async () => {
    let call = 0;
    const verifyTypedData: VerifyTypedDataFn =
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => {
        call += 1;
        return call === 1; // first ok, second fails
      };
    const deps = depsWith({ verifyTypedData });
    await onboardStartHandler(startBody, deps);
    await expect(
      onboardCompleteHandler(
        {
          provisionalId: '00000000-0000-0000-0000-000000000001',
          approveAgentSig: '0xaa',
          approveBuilderFeeSig: '0xbb',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'signature_mismatch' });
  });

  it('errors when provisional row is missing', async () => {
    const deps = depsWith();
    await expect(
      onboardCompleteHandler(
        {
          provisionalId: '00000000-0000-0000-0000-000000000001',
          approveAgentSig: '0xaa',
          approveBuilderFeeSig: '0xbb',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'provisional_not_found' });
  });

  it('rejects a malformed body', async () => {
    const deps = depsWith();
    await expect(onboardCompleteHandler({ provisionalId: 'nope' }, deps)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
