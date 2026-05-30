/**
 * @whalepod/vault — Agent-key envelope encryption + safe-decrypt signer.
 *
 * Source of truth: docs/phase-2.md §3.3 (custody model), §4.1 (users table).
 *
 * Invariants:
 *  - Agent private keys at rest are AES-256-GCM-encrypted; the DEK is
 *    KMS-encrypted under the service CMK.
 *  - Plaintext private keys live in process memory only inside
 *    `withAgentSigner` and are zeroized in `finally`.
 *  - KMS encryptionContext binds the ciphertext to a user/purpose tuple;
 *    swapping a ciphertext blob to a different user fails decryption.
 */
export { generateAgentKey, type NewAgentKey } from './agentKey.js';
export {
  sealAgentKey,
  openAgentKey,
  type SealedAgentKey,
  type SealParams,
  type OpenParams,
} from './envelope.js';
export { withAgentSigner, type WithAgentSignerParams } from './signer.js';
export type { VaultKms } from './kms.js';
export { FakeKms } from './fakeKms.js';
