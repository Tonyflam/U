import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { openAgentKey, sealAgentKey } from './envelope.js';
import { FakeKms } from './fakeKms.js';

const ctx = { userId: 'u-1', purpose: 'agent-key' };

describe('sealAgentKey / openAgentKey', () => {
  it('round-trips an agent private key', async () => {
    const kms = new FakeKms();
    const pk = new Uint8Array(32).fill(7);
    const sealed = await sealAgentKey({ privateKey: pk, kms, encryptionContext: ctx });
    const opened = await openAgentKey({ sealed, kms, encryptionContext: ctx });
    expect(Buffer.from(opened).equals(Buffer.from(pk))).toBe(true);
  });

  it('produces a non-empty ciphertext distinct from plaintext', async () => {
    const kms = new FakeKms();
    const pk = new Uint8Array(32).fill(3);
    const sealed = await sealAgentKey({ privateKey: pk, kms, encryptionContext: ctx });
    expect(sealed.ct.length).toBeGreaterThan(0);
    expect(sealed.iv.length).toBe(12);
    expect(sealed.tag.length).toBe(16);
    expect(Buffer.from(sealed.ct).equals(Buffer.from(pk))).toBe(false);
  });

  it('rejects decryption when the KMS encryptionContext differs', async () => {
    const kms = new FakeKms();
    const pk = new Uint8Array(32).fill(11);
    const sealed = await sealAgentKey({ privateKey: pk, kms, encryptionContext: ctx });
    await expect(
      openAgentKey({ sealed, kms, encryptionContext: { userId: 'someone-else' } }),
    ).rejects.toThrow();
  });

  it('rejects decryption when the AES-GCM tag is tampered', async () => {
    const kms = new FakeKms();
    const pk = new Uint8Array(32).fill(13);
    const sealed = await sealAgentKey({ privateKey: pk, kms, encryptionContext: ctx });
    const badTag = new Uint8Array(sealed.tag);
    badTag[0] = badTag[0]! ^ 0xff;
    await expect(
      openAgentKey({
        sealed: { ...sealed, tag: badTag },
        kms,
        encryptionContext: ctx,
      }),
    ).rejects.toThrow();
  });

  it('rejects decryption when the ciphertext is tampered', async () => {
    const kms = new FakeKms();
    const pk = new Uint8Array(32).fill(17);
    const sealed = await sealAgentKey({ privateKey: pk, kms, encryptionContext: ctx });
    const badCt = new Uint8Array(sealed.ct);
    badCt[0] = badCt[0]! ^ 0x01;
    await expect(
      openAgentKey({ sealed: { ...sealed, ct: badCt }, kms, encryptionContext: ctx }),
    ).rejects.toThrow();
  });

  it('property: random 32-byte keys round-trip exactly', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (bytes) => {
        const kms = new FakeKms();
        const sealed = await sealAgentKey({
          privateKey: bytes,
          kms,
          encryptionContext: ctx,
        });
        const opened = await openAgentKey({ sealed, kms, encryptionContext: ctx });
        return Buffer.from(opened).equals(Buffer.from(bytes));
      }),
      { numRuns: 25 },
    );
  });
});
