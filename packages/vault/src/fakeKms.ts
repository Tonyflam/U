import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { VaultKms } from '../src/kms.js';

/**
 * Deterministic in-process KMS impl for tests.
 *
 * `generateDataKey` returns a fresh 32-byte plaintext DEK and a ciphertext
 * blob that is `(iv ‖ tag ‖ ct)` of the DEK under a fixed root key, with the
 * encryptionContext (canonicalized) used as AEAD additional data. This means
 * `decrypt(ct, ctxA)` for a blob produced with `ctxB` fails — matching real
 * KMS's `InvalidCiphertextException`.
 */
export class FakeKms implements VaultKms {
  private readonly rootKey: Uint8Array;
  public decryptCount = 0;
  public generateCount = 0;

  constructor(rootKey?: Uint8Array) {
    this.rootKey = rootKey ?? randomBytes(32);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async generateDataKey(
    encryptionContext?: Record<string, string>,
  ): Promise<{ plaintext: Uint8Array; ciphertext: Uint8Array }> {
    this.generateCount += 1;
    const plaintext = randomBytes(32);
    const ciphertext = this.sealDek(plaintext, encryptionContext);
    return { plaintext: new Uint8Array(plaintext), ciphertext };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async decrypt(
    ciphertext: Uint8Array,
    encryptionContext?: Record<string, string>,
  ): Promise<Uint8Array> {
    this.decryptCount += 1;
    return this.openDek(ciphertext, encryptionContext);
  }

  private sealDek(dek: Uint8Array, ctx?: Record<string, string>): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.rootKey, iv);
    cipher.setAAD(canonAad(ctx));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([iv, tag, ct]));
  }

  private openDek(blob: Uint8Array, ctx?: Record<string, string>): Uint8Array {
    const buf = Buffer.from(blob);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.rootKey, iv);
    decipher.setAAD(canonAad(ctx));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  }
}

function canonAad(ctx?: Record<string, string>): Buffer {
  if (!ctx) return Buffer.alloc(0);
  const keys = Object.keys(ctx).sort();
  const parts = keys.map((k) => `${k}=${ctx[k] ?? ''}`);
  return Buffer.from(parts.join('&'), 'utf8');
}
