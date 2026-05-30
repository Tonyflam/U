/**
 * Minimal KMS surface the vault depends on. `KmsClient` from `@whalepod/config`
 * satisfies this shape; tests pass a deterministic fake.
 */
export interface VaultKms {
  generateDataKey(
    encryptionContext?: Record<string, string>,
  ): Promise<{ plaintext: Uint8Array; ciphertext: Uint8Array }>;
  decrypt(ciphertext: Uint8Array, encryptionContext?: Record<string, string>): Promise<Uint8Array>;
}
