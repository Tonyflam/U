/**
 * Hyperliquid L1 action signing.
 *
 * L1 actions (orders, cancels, modify, etc.) are signed via EIP-712 over a
 * synthetic `Agent` typed-data envelope whose `connectionId` is the keccak
 * hash of `msgpack(action) || nonce_be8 || hasVault_u8 [|| vault_addr_20]`.
 *
 * Refs:
 *   - HL docs: signing-overview / L1 actions
 *   - @nktkas/hyperliquid reference impl
 *
 * Verification: viem's `signTypedData` produces a signature that HL recovers
 * with the same Agent domain. The chain source field is `'Mainnet'|'Testnet'`,
 * pinned to our env (the same value as the action's `chain` slot).
 *
 * NOTE: we intentionally do NOT export an "encode any action" helper —
 * `signL1Action` only takes pre-built actions from this SDK (the only
 * code paths that produce HL actions in our codebase live in this package
 * and are linter-blocked from including withdrawal strings).
 */
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { bytesToHex, hexToBytes, keccak256, type Hex, type LocalAccount } from 'viem';
import { HL_SIG_CHAIN_ID } from './constants.js';
import type { HlSignature } from './transport.js';

const AGENT_PRIMARY_TYPE = 'Agent';

const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

const L1_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

export interface SignL1ActionParams {
  /** Pre-built HL action (e.g. `HlOrderAction`). */
  readonly action: unknown;
  /** Monotonic nonce (ms since epoch is the canonical choice). */
  readonly nonce: number;
  /** Optional vault sub-account. Omit for the user's own account. */
  readonly vaultAddress?: `0x${string}`;
  /** Network the action targets. Pinned alongside our env. */
  readonly isMainnet: boolean;
  /** Viem account that will sign (the agent key, derived in `withAgentSigner`). */
  readonly account: Pick<LocalAccount, 'signTypedData'>;
}

/**
 * Build the `connectionId` HL expects:
 *
 *   keccak256(msgpack(action) || nonce_u64_be || hasVault_u8 [|| vault_addr_20])
 */
export function buildL1ConnectionId(args: {
  readonly action: unknown;
  readonly nonce: number;
  readonly vaultAddress?: `0x${string}`;
}): Hex {
  const packed = msgpackEncode(args.action) as Uint8Array;
  const nonceBuf = new Uint8Array(8);
  // 64-bit big-endian write — Number.MAX_SAFE_INTEGER ≈ 2^53 < 2^64.
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(args.nonce), false);
  const hasVault = args.vaultAddress !== undefined;
  const vaultBytes = hasVault ? hexToBytes(args.vaultAddress) : new Uint8Array(0);
  const flag = new Uint8Array([hasVault ? 1 : 0]);
  const total = packed.length + nonceBuf.length + flag.length + vaultBytes.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(packed, o);
  o += packed.length;
  out.set(nonceBuf, o);
  o += nonceBuf.length;
  out.set(flag, o);
  o += flag.length;
  if (vaultBytes.length > 0) out.set(vaultBytes, o);
  return keccak256(bytesToHex(out));
}

/**
 * Sign an HL L1 action with the agent account. Returns the {r,s,v} triple
 * the transport submits inline.
 */
export async function signL1Action(params: SignL1ActionParams): Promise<HlSignature> {
  const connectionId = buildL1ConnectionId({
    action: params.action,
    nonce: params.nonce,
    ...(params.vaultAddress !== undefined ? { vaultAddress: params.vaultAddress } : {}),
  });
  const source = params.isMainnet ? 'a' : 'b';
  const signature = await params.account.signTypedData({
    domain: L1_DOMAIN,
    types: AGENT_TYPES,
    primaryType: AGENT_PRIMARY_TYPE,
    message: { source, connectionId },
  });
  return splitSignature(signature);
}

/** Pinned for cross-checks — HL signing chain is Arbitrum. */
export const HL_SIGNING_CHAIN_ID = HL_SIG_CHAIN_ID;

function splitSignature(sig: `0x${string}`): HlSignature {
  if (sig.length !== 132) {
    throw new Error(`unexpected signature length: ${String(sig.length)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- template-literal type narrowing
  const r = `0x${sig.slice(2, 66)}` as `0x${string}`;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- template-literal type narrowing
  const s = `0x${sig.slice(66, 130)}` as `0x${string}`;
  const vHex = sig.slice(130, 132);
  const v = Number.parseInt(vHex, 16);
  return { r, s, v };
}
