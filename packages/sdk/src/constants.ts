/**
 * Hyperliquid protocol constants. Source: Phase 0 verification queue + docs/phase-2.md.
 *
 * These are NOT configurable. Changing any value here implies a protocol-level
 * change and requires re-verification of every threat-model assumption.
 */

/** EIP-712 chainId used for HL signing. Pinned to Arbitrum. */
export const HL_SIG_CHAIN_ID = '0xa4b1';

/** Numeric form of `HL_SIG_CHAIN_ID` — used as EIP-712 domain.chainId. */
export const HL_DOMAIN_CHAIN_ID = 42161;

/** EIP-712 verifyingContract for all HL actions (canonical zero address). */
export const HL_VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000000';

/** EIP-712 domain name for all HL actions. */
export const HL_DOMAIN_NAME = 'HyperliquidSignTransaction';

/** EIP-712 domain version. */
export const HL_DOMAIN_VERSION = '1';

/** Mainnet REST base. */
export const HL_MAINNET_URL = 'https://api.hyperliquid.xyz';

/** Testnet REST base. */
export const HL_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

/**
 * Protocol-enforced cap on perp builder fees: 10 bps = 100 tenths of a bp.
 * Spot is 1% = 1000 tenths of a bp but we do not trade spot — perps only.
 */
export const BUILDER_FEE_PERP_CAP_TENTHS_BP = 100;

/** Our default builder fee: 5 bps = 50 tenths of a bp. */
export const BUILDER_FEE_DEFAULT_TENTHS_BP = 50;
