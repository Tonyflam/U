import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { hexToBytes, type Hex } from 'viem';

export interface NewAgentKey {
  /** Lowercase 0x-prefixed address derived from the private key. */
  address: `0x${string}`;
  /** 32-byte private key. Caller MUST `zeroize` after use. */
  privateKey: Uint8Array;
}

/**
 * Generate a fresh agent (sub-account) keypair via viem.
 *
 * The returned `privateKey` Uint8Array is the only copy held by this process.
 * Hand it to `sealAgentKey` immediately, then `zeroize` it.
 */
export function generateAgentKey(): NewAgentKey {
  const hex: Hex = generatePrivateKey();
  const address = privateKeyToAddress(hex).toLowerCase() as `0x${string}`;
  const privateKey = hexToBytes(hex);
  return { address, privateKey };
}
