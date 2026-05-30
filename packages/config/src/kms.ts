import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';

export interface KmsClientOptions {
  region: string;
  keyId: string;
  /** Optional client overrides — primarily for tests (custom endpoint, creds). */
  clientConfig?: Omit<KMSClientConfig, 'region'>;
}

/**
 * Thin wrapper around AWS KMS for the limited operations WhalePod performs:
 * - encrypt / decrypt small blobs (< 4 KB) directly with the CMK
 * - generate envelope data keys for larger payloads
 *
 * Long-term key material lives only in KMS. This service never sees the CMK.
 */
export class KmsClient {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(options: KmsClientOptions) {
    this.client = new KMSClient({ region: options.region, ...options.clientConfig });
    this.keyId = options.keyId;
  }

  /**
   * Encrypt up to 4 KB of plaintext directly with the CMK.
   * For larger payloads use `generateDataKey` + AES-GCM in the caller.
   */
  async encrypt(
    plaintext: Uint8Array,
    encryptionContext?: Record<string, string>,
  ): Promise<Uint8Array> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: plaintext,
        EncryptionContext: encryptionContext,
      }),
    );
    if (!out.CiphertextBlob) {
      throw new Error('KMS encrypt returned no ciphertext');
    }
    return out.CiphertextBlob;
  }

  /**
   * Decrypt a CMK-encrypted blob. Caller MUST zeroize the returned plaintext
   * with `zeroize()` once consumed.
   */
  async decrypt(
    ciphertext: Uint8Array,
    encryptionContext?: Record<string, string>,
  ): Promise<Uint8Array> {
    const out = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: ciphertext,
        EncryptionContext: encryptionContext,
      }),
    );
    if (!out.Plaintext) {
      throw new Error('KMS decrypt returned no plaintext');
    }
    return out.Plaintext;
  }

  /**
   * Generate an envelope data key. Returns both the plaintext key (for in-process
   * crypto, must be zeroized) and the encrypted form (safe to persist).
   */
  async generateDataKey(
    encryptionContext?: Record<string, string>,
    keySpec: 'AES_256' | 'AES_128' = 'AES_256',
  ): Promise<{ plaintext: Uint8Array; ciphertext: Uint8Array }> {
    const out = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: keySpec,
        EncryptionContext: encryptionContext,
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) {
      throw new Error('KMS generateDataKey returned incomplete response');
    }
    return { plaintext: out.Plaintext, ciphertext: out.CiphertextBlob };
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Overwrite a buffer with zeros in place. Use in `finally` blocks anywhere a
 * private key or symmetric key briefly lives in memory.
 *
 * Note: V8 may copy/move bytes; this is best-effort, not a guarantee. The
 * authoritative defense is keeping plaintext lifetime as short as possible.
 */
export function zeroize(buf: Uint8Array | undefined | null): void {
  if (!buf) return;
  buf.fill(0);
}
