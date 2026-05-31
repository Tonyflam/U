/**
 * @whalepod/sdk — Hyperliquid action construction with builder code baked in
 * and fee clamping enforced. This is the entire security-critical surface
 * for U4. Transport (signing + HTTP) is wired in U5/U6.
 */
export * from './constants.js';
export * from './types.js';
export { clampFeeTenthsBp, feeRateString } from './fee.js';
export { buildOrderAction, type BuildOrderActionInput } from './order.js';
export {
  buildApproveBuilderFeeAction,
  buildRevokeBuilderFeeAction,
  type BuildApproveBuilderFeeInput,
} from './builder.js';
export { buildApproveAgentAction, type BuildApproveAgentInput } from './agent.js';
export {
  TPSL_MAX_BPS,
  TPSL_MIN_BPS,
  TpSlConfigError,
  buildTriggerOrderAction,
  computeTriggerPx,
  type BuildTriggerOrderActionInput,
  type ComputeTriggerPxInput,
  type TpSl,
} from './trigger.js';
export {
  HL_TYPED_DATA_DOMAIN,
  buildApproveAgentTypedData,
  buildApproveBuilderFeeTypedData,
  type TypedDataPayload,
} from './sign.js';
export {
  HttpHlTransport,
  HlExchangeError,
  HlTransportError,
  hlBaseUrl,
  type HlExchangeRequest,
  type HlExchangeResponse,
  type HlExchangeResponseOk,
  type HlExchangeResponseErr,
  type HlSignature,
  type HttpHlTransportOptions,
} from './transport.js';
export {
  HL_SIGNING_CHAIN_ID,
  buildL1ConnectionId,
  signL1Action,
  type SignL1ActionParams,
} from './signL1.js';
export { signTradeShare, verifyTradeShare, type TradeSharePayload } from './shareToken.js';
