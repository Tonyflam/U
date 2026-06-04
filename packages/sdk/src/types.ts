import type { Address } from '@whalepod/schema';
import type { HL_SIG_CHAIN_ID } from './constants.js';

/** Branded integer in tenths of a basis point. e.g. 50 = 0.05% = 5 bps. */
export type TenthsBp = number & { readonly __brand: 'TenthsBp' };

/** Builder field present on every order action we sign. */
export interface BuilderField {
  /** Builder's Hyperliquid address (lowercased). */
  readonly b: Address;
  /** Builder fee for THIS order in tenths of a basis point. */
  readonly f: number;
}

/** Side of an order. */
export type Side = 'B' | 'S';

/**
 * Pure intent object produced by the Mirror Engine or TG command handler.
 * The SDK turns this into a signed HL `order` action; nothing else in the
 * intent shape may differ between operator-controlled and user-controlled
 * sources (see threat: "operator front-run").
 */
export interface OrderIntent {
  /** Hyperliquid asset index (BTC=0, ETH=1, etc — resolved upstream). */
  readonly asset: number;
  /** true = buy, false = sell. */
  readonly isBuy: boolean;
  /** Limit price as decimal string. "0" for market orders (Ioc with high slippage). */
  readonly limitPx: string;
  /** Size as decimal string. */
  readonly sz: string;
  /** Reduce-only flag. */
  readonly reduceOnly: boolean;
  /** Time-in-force. */
  readonly tif: 'Gtc' | 'Ioc' | 'Alo';
  /** Optional client order id. If absent, caller assigns. */
  readonly cloid?: `0x${string}`;
}

/**
 * The HL `order` action payload as we construct it. The shape mirrors the
 * `@nktkas/hyperliquid` order action contract; we hold to the field names
 * verbatim so they pass straight through to the transport layer in U5/U6.
 */
export interface HlOrderAction {
  readonly type: 'order';
  readonly orders: readonly HlOrderRequest[];
  readonly grouping: 'na' | 'normalTpsl' | 'positionTpsl';
  readonly builder: BuilderField;
}

export interface HlOrderRequest {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t:
    | { readonly limit: { readonly tif: 'Gtc' | 'Ioc' | 'Alo' } }
    | {
        readonly trigger: {
          readonly isMarket: boolean;
          readonly triggerPx: string;
          readonly tpsl: 'tp' | 'sl';
        };
      };
  readonly c?: `0x${string}`;
}

/** HL `approveBuilderFee` action. */
export interface HlApproveBuilderFeeAction {
  readonly type: 'approveBuilderFee';
  readonly hyperliquidChain: 'Mainnet' | 'Testnet';
  readonly signatureChainId: typeof HL_SIG_CHAIN_ID;
  readonly maxFeeRate: string;
  readonly builder: Address;
  readonly nonce: number;
}

/** HL `approveAgent` action. User signs from their MAIN wallet to authorize
 *  a sub-account agent key on Hyperliquid. The agent cannot withdraw — that
 *  is a protocol-level constraint, reinforced by our codebase ESLint rules. */
export interface HlApproveAgentAction {
  readonly type: 'approveAgent';
  readonly hyperliquidChain: 'Mainnet' | 'Testnet';
  readonly signatureChainId: typeof HL_SIG_CHAIN_ID;
  readonly agentAddress: Address;
  readonly agentName: string;
  readonly nonce: number;
}

/**
 * HL `updateLeverage` L1 action. Sets the leverage HL applies to the
 * NEXT order on `asset` for the signing wallet. We use `isCross: true`
 * (cross-margin) to match WhalePod's risk model — each new mirror is
 * sized against the user's full account equity, not isolated margin.
 *
 * No builder field — this is a position-management action, not a trade.
 */
export interface HlUpdateLeverageAction {
  readonly type: 'updateLeverage';
  readonly asset: number;
  readonly isCross: boolean;
  readonly leverage: number;
}
