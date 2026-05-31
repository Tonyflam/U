/**
 * Side-effect orchestrator that turns a `MirrorDecision (submit)` into a
 * real Hyperliquid order submission, gated by the pure risk engine and
 * audited end-to-end.
 *
 * Layers, executed in order — every layer can short-circuit the flow:
 *
 *   1. `evaluateMirror` produced a `submit` decision (caller's job).
 *   2. `evaluateRisk` adds equity-floor / slippage / daily-notional / geo.
 *   3. Sign + POST to HL `/exchange` via injected `signer`+`transport`.
 *   4. Increment 24h rolling notional (counts only *after* HL ack).
 *   5. Append an audit row for the outcome (submitted | risk_blocked | failed).
 *
 * The function returns a `MirrorOutcome` describing what happened — never
 * throws for "expected" branches (risk block, HL err). Network/signer
 * exceptions surface as `outcome: 'transport_error'` with the cause
 * attached and an audit row written. This keeps the consumer loop simple:
 * one call, always one audit row, never crash the worker.
 */
import type { Address } from '@whalepod/schema';
import {
  HlExchangeError,
  HlTransportError,
  type HlExchangeResponseOk,
  type HttpHlTransport,
  type HlSignature,
} from '@whalepod/sdk';
import type { MirrorDecision, UserSnapshot, SubscriptionSnapshot } from './mirrorEngine.js';
import type { OrderIntent, HlOrderAction } from '@whalepod/sdk';
import { evaluateRisk, type RiskBlockReason, type RiskDeps, type RiskInput } from './riskEngine.js';
import type { FillPublisher } from './fillPublisher.js';
import type { FillSink } from './fillSink.js';
import type { MirrorFillEvent } from './notify.js';

export interface AgentSigner {
  /** Returns an HL signature for the given action + nonce, scoped to `userId`. */
  sign(input: {
    readonly userId: string;
    readonly agentAddress: Address;
    readonly action: HlOrderAction;
    readonly nonce: number;
  }): Promise<HlSignature>;
}

export interface DailyNotionalIncrementer {
  /** Atomically add `usd` to the user's rolling 24h notional bucket. */
  add(userId: string, usd: number, atMs: number): Promise<void>;
}

export interface AuditSink {
  appendAudit(entry: {
    readonly actor: string;
    readonly action: string;
    readonly target: string;
    readonly before?: unknown;
    readonly after?: unknown;
  }): Promise<void>;
}

export interface SubmitMirrorDeps {
  readonly risk: RiskDeps;
  readonly signer: AgentSigner;
  readonly transport: Pick<HttpHlTransport, 'exchange'>;
  readonly notionalSink: DailyNotionalIncrementer;
  readonly audit: AuditSink;
  /** Optional notification fan-out; failures are best-effort and never fatal. */
  readonly publisher?: FillPublisher;
  /** Optional durable fill recorder; failures are best-effort and never fatal. */
  readonly fillSink?: FillSink;
  /** Wall-clock now (ms). Injected so tests are deterministic. */
  readonly now: () => number;
  /** Monotonic nonce factory. HL requires ms-since-epoch; typically
   * `() => Math.max(Date.now(), last + 1)`. Microseconds will be rejected
   * with "nonce too high". */
  readonly nonce: () => number;
}

export type MirrorOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'risk_blocked';
      readonly reason: RiskBlockReason;
      readonly detail?: string;
    }
  | {
      readonly kind: 'submitted';
      readonly cloid: `0x${string}`;
      readonly response: HlExchangeResponseOk['response'];
      readonly feeTenthsBp: number;
      readonly mirrorSizeUsd: number;
    }
  | {
      readonly kind: 'exchange_error';
      readonly cloid: `0x${string}`;
      readonly message: string;
    }
  | {
      readonly kind: 'transport_error';
      readonly cloid?: `0x${string}`;
      readonly message: string;
    };

const AUDIT_ACTION = 'mirror.submit';

export async function submitMirror(
  decision: MirrorDecision,
  deps: SubmitMirrorDeps,
): Promise<MirrorOutcome> {
  if (decision.kind === 'skip') {
    return { kind: 'skipped', reason: decision.reason };
  }

  const { user, subscription, action, orderIntent, mirrorSizeUsd, feeTenthsBp, cloid } = decision;
  const now = deps.now();

  const riskInput: RiskInput = {
    userId: user.id,
    equityFloorUsd: user.equityFloorUsd,
    mirrorSizeUsd,
    px: Number(orderIntent.limitPx),
    refPx: Number(orderIntent.limitPx),
    now,
  };
  const risk = await evaluateRisk(riskInput, deps.risk);
  if (risk.kind === 'block') {
    await deps.audit.appendAudit({
      actor: `op:${user.id}`,
      action: AUDIT_ACTION,
      target: `cloid:${cloid}`,
      before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
      after: { outcome: 'risk_blocked', reason: risk.reason, detail: risk.detail },
    });
    return {
      kind: 'risk_blocked',
      reason: risk.reason,
      ...(risk.detail !== undefined ? { detail: risk.detail } : {}),
    };
  }

  const nonce = deps.nonce();
  let signature: HlSignature;
  try {
    signature = await deps.signer.sign({
      userId: user.id,
      agentAddress: user.agentAddress,
      action,
      nonce,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.audit.appendAudit({
      actor: `op:${user.id}`,
      action: AUDIT_ACTION,
      target: `cloid:${cloid}`,
      before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
      after: { outcome: 'transport_error', stage: 'sign', message },
    });
    return { kind: 'transport_error', cloid, message };
  }

  try {
    const res = await deps.transport.exchange({ action, signature, nonce });
    await deps.notionalSink.add(user.id, mirrorSizeUsd, now);
    await deps.audit.appendAudit({
      actor: `op:${user.id}`,
      action: AUDIT_ACTION,
      target: `cloid:${cloid}`,
      before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
      after: { outcome: 'submitted', response: res.response, nonce },
    });
    if (deps.publisher !== undefined) {
      const feeUsd = (mirrorSizeUsd * feeTenthsBp) / 100000;
      const event: MirrorFillEvent = {
        idempotencyKey: cloid,
        whaleAddress: subscription.whaleAddress,
        coin: decision.coin,
        side: orderIntent.isBuy ? 'B' : 'S',
        px: orderIntent.limitPx,
        sz: orderIntent.sz,
        notionalUsd: mirrorSizeUsd.toFixed(2),
        builderFeeTenthsBp: feeTenthsBp,
        builderFeeUsd: feeUsd.toFixed(6),
        ts: now,
      };
      await deps.publisher.publish(event, user.id);
    }
    if (deps.fillSink !== undefined) {
      const feeUsd = (mirrorSizeUsd * feeTenthsBp) / 100000;
      await deps.fillSink.recordMirrorFill({
        hlFillId: cloid,
        whaleAddress: subscription.whaleAddress,
        coin: decision.coin,
        side: orderIntent.isBuy ? 'B' : 'S',
        px: orderIntent.limitPx,
        sz: orderIntent.sz,
        notionalUsd: mirrorSizeUsd.toFixed(2),
        builderFeeTenthsBp: feeTenthsBp,
        builderFeeUsd: feeUsd.toFixed(6),
        userId: user.id,
        ts: now,
      });
    }
    return {
      kind: 'submitted',
      cloid,
      response: res.response,
      feeTenthsBp,
      mirrorSizeUsd,
    };
  } catch (err) {
    if (err instanceof HlExchangeError) {
      await deps.audit.appendAudit({
        actor: `op:${user.id}`,
        action: AUDIT_ACTION,
        target: `cloid:${cloid}`,
        before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
        after: { outcome: 'exchange_error', message: err.body.response, nonce },
      });
      return { kind: 'exchange_error', cloid, message: err.body.response };
    }
    const message =
      err instanceof HlTransportError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await deps.audit.appendAudit({
      actor: `op:${user.id}`,
      action: AUDIT_ACTION,
      target: `cloid:${cloid}`,
      before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
      after: { outcome: 'transport_error', stage: 'exchange', message, nonce },
    });
    return { kind: 'transport_error', cloid, message };
  }
}

function summarize(
  user: UserSnapshot,
  sub: SubscriptionSnapshot,
  intent: OrderIntent,
  feeTenthsBp: number,
  mirrorSizeUsd: number,
): Record<string, unknown> {
  return {
    userId: user.id,
    subscriptionId: sub.id,
    whaleAddress: sub.whaleAddress,
    coin: intent.asset,
    isBuy: intent.isBuy,
    limitPx: intent.limitPx,
    sz: intent.sz,
    feeTenthsBp,
    mirrorSizeUsd,
  };
}
