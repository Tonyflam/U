import { describe, expect, it } from 'vitest';
import { generateAgentKey } from './agentKey.js';
import { sealAgentKey } from './envelope.js';
import { withAgentSigner } from './signer.js';
import { FakeKms } from './fakeKms.js';

const ctx = { userId: 'u-42', purpose: 'agent-key' };

describe('withAgentSigner', () => {
  it('exposes a viem account whose address matches the generated key', async () => {
    const kms = new FakeKms();
    const k = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: k.privateKey,
      kms,
      encryptionContext: ctx,
    });
    const addr = await withAgentSigner(
      { sealed, kms, encryptionContext: ctx },
      // eslint-disable-next-line @typescript-eslint/require-await
      async (account) => account.address.toLowerCase(),
    );
    expect(addr).toBe(k.address);
  });

  it('signs a message via the decrypted account', async () => {
    const kms = new FakeKms();
    const k = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: k.privateKey,
      kms,
      encryptionContext: ctx,
    });
    const sig = await withAgentSigner({ sealed, kms, encryptionContext: ctx }, (account) =>
      account.signMessage({ message: 'hello' }),
    );
    expect(sig).toMatch(/^0x[0-9a-f]+$/);
  });

  it('runs the finally branch (zeroize path) when the callback throws', async () => {
    const kms = new FakeKms();
    const k = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: k.privateKey,
      kms,
      encryptionContext: ctx,
    });
    await expect(
      withAgentSigner({ sealed, kms, encryptionContext: ctx }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // If finally didn't run, we'd see a hang; reaching here means the promise settled.
    expect(kms.decryptCount).toBe(1);
  });

  it('calls KMS decrypt exactly once per invocation', async () => {
    const kms = new FakeKms();
    const k = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: k.privateKey,
      kms,
      encryptionContext: ctx,
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    await withAgentSigner({ sealed, kms, encryptionContext: ctx }, async () => undefined);
    // eslint-disable-next-line @typescript-eslint/require-await
    await withAgentSigner({ sealed, kms, encryptionContext: ctx }, async () => undefined);
    expect(kms.decryptCount).toBe(2);
  });
});
