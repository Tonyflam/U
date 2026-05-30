import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';
import type { PrivateKeyAccount } from 'viem';
import { zeroize } from '@whalepod/config';
import { openAgentKey, type SealedAgentKey } from './envelope.js';
import type { VaultKms } from './kms.js';

export interface WithAgentSignerParams {
  sealed: SealedAgentKey;
  kms: VaultKms;
  encryptionContext: Record<string, string>;
}

/**
 * Decrypt an agent key, hand the resulting viem account to `fn`, and zeroize
 * the plaintext private-key buffer once `fn` resolves OR throws.
 *
 * This is the ONLY supported way to use an agent key for signing. Order Router
 * call sites pass an L1-action signer; signature happens entirely inside `fn`
 * before the buffer is wiped.
 *
 * Note on viem internals: `privateKeyToAccount(hex)` derives a static
 * public/secret pair and the returned account closes over its own copy. Wiping
 * our buffer therefore does not break further `account.signMessage` etc., but
 * shortens the plaintext-in-RAM window to a single function scope.
 */
export async function withAgentSigner<T>(
  params: WithAgentSignerParams,
  fn: (account: PrivateKeyAccount) => Promise<T>,
): Promise<T> {
  const pk = await openAgentKey({
    sealed: params.sealed,
    kms: params.kms,
    encryptionContext: params.encryptionContext,
  });
  try {
    const account = privateKeyToAccount(bytesToHex(pk));
    return await fn(account);
  } finally {
    zeroize(pk);
  }
}
