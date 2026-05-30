import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { zeroize } from '@whalepod/config';
import type { VaultKms } from './kms.js';

/**
 * Envelope-encrypted agent key blob.
 *
 * `dekCt` is the AES-256 data-encryption-key, encrypted by AWS KMS under the
 * service CMK. `ct`/`iv`/`tag` are the AES-256-GCM-encrypted agent private key.
 * KMS never sees the agent key itself — the DEK is the only thing KMS holds
 * ciphertext for.
 */
export interface SealedAgentKey {
  ct: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  dekCt: Uint8Array;
}

export interface SealParams {
  privateKey: Uint8Array;
  kms: VaultKms;
  /** Bound into both the KMS request AND not stored anywhere else; protects
   *  against ciphertext swap attacks. Typically `{ userId, purpose: 'agent-key' }`. */
  encryptionContext: Record<string, string>;
}

export interface OpenParams {
  sealed: SealedAgentKey;
  kms: VaultKms;
  encryptionContext: Record<string, string>;
}

/**
 * Encrypt an agent private key for at-rest storage.
 *
 * The plaintext DEK lives in process memory for the duration of one
 * `cipher.update`/`final` call and is zeroized in `finally`. `privateKey` is
 * NOT zeroized by this function — the caller owns it.
 */
export async function sealAgentKey(params: SealParams): Promise<SealedAgentKey> {
  const { privateKey, kms, encryptionContext } = params;
  const dek = await kms.generateDataKey(encryptionContext);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek.plaintext, iv);
    const ctParts = [cipher.update(privateKey), cipher.final()];
    const tag = cipher.getAuthTag();
    return {
      ct: Buffer.concat(ctParts),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(tag),
      dekCt: dek.ciphertext,
    };
  } finally {
    zeroize(dek.plaintext);
  }
}

/**
 * Decrypt a sealed agent key. Returned buffer is the private key plaintext;
 * the caller MUST `zeroize` it (typically via `withAgentSigner`'s finally).
 */
export async function openAgentKey(params: OpenParams): Promise<Uint8Array> {
  const { sealed, kms, encryptionContext } = params;
  const dekPlain = await kms.decrypt(sealed.dekCt, encryptionContext);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dekPlain, sealed.iv);
    decipher.setAuthTag(sealed.tag);
    const out = Buffer.concat([decipher.update(sealed.ct), decipher.final()]);
    return new Uint8Array(out);
  } finally {
    zeroize(dekPlain);
  }
}
