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
  buildTriggerOrderAction,
  computeTriggerPx,
} from '@whalepod/sdk';
import type { MirrorDecision, UserSnapshot, SubscriptionSnapshot } from './mirrorEngine.js';
import type { OrderIntent, HlOrderAction, HlUpdateLeverageAction } from '@whalepod/sdk';
import { evaluateRisk, type RiskBlockReason, type RiskDeps, type RiskInput } from './riskEngine.js';
import type { FillPublisher } from './fillPublisher.js';
import type { FillSink } from './fillSink.js';
import type { MirrorFillEvent } from './notify.js';
import type { LeverageSyncer } from './leverageSyncer.js';

export interface AgentSigner {
  /** Returns an HL signature for the given action + nonce, scoped to `userId`. */
  sign(input: {
    readonly userId: string;
    readonly agentAddress: Address;
    readonly action: HlOrderAction | HlUpdateLeverageAction;
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
  /** Optional just-in-time leverage syncer. When provided, runs before
   *  every entry sign — sends HL `updateLeverage` if the cap differs from
   *  what was last synced for (user, asset). Failures are non-fatal. */
  readonly leverageSyncer?: LeverageSyncer;
  /** Wall-clock now (ms). Injected so tests are deterministic. */
  readonly now: () => number;
  /** Monotonic nonce factory. HL requires ms-since-epoch; typically
   * `() => Math.max(Date.now(), last + 1)`. Microseconds will be rejected
   * with "nonce too high". */
  readonly nonce: () => number;
  /**
   * Optional last-second re-check, called immediately before sign + POST.
   * Resolves race: user types /pause or /kill while a mirror is mid-flight
   * (after the engine read snapshots but before we hit HL). If this returns
   * a string reason, the order is aborted and reported as `skipped`.
   *
   * Production wires this to a fresh DB read of `paused` + `killSwitch`.
   * Tests can omit.
   */
  readonly preflight?: (input: {
    readonly userId: string;
    readonly whaleAddress: string;
  }) => Promise<string | null>;
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

  if (deps.preflight) {
    const abort = await deps.preflight({
      userId: user.id,
      whaleAddress: subscription.whaleAddress,
    });
    if (abort !== null) {
      await deps.audit.appendAudit({
        actor: `op:${user.id}`,
        action: AUDIT_ACTION,
        target: `cloid:${cloid}`,
        before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
        after: { outcome: 'preflight_aborted', reason: abort },
      });
      return { kind: 'skipped', reason: abort };
    }
  }

  // Best-effort leverage sync: HL persists leverage per (wallet, asset),
  // so we send updateLeverage here only when the cap changed since the
  // last mirror for this asset. Failures are logged and we continue —
  // worst case one trade at the wrong leverage instead of zero trades.
  if (deps.leverageSyncer && subscription.maxLeverage > 0) {
    const assetIdx = action.orders[0]?.a;
    if (assetIdx !== undefined) {
      await deps.leverageSyncer.ensure({
        userId: user.id,
        agentAddress: user.agentAddress,
        asset: assetIdx,
        leverage: subscription.maxLeverage,
      });
    }
  }

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
    const orderError = extractOrderError(res.response);
    if (orderError !== undefined) {
      await deps.audit.appendAudit({
        actor: `op:${user.id}`,
        action: AUDIT_ACTION,
        target: `cloid:${cloid}`,
        before: summarize(user, subscription, orderIntent, feeTenthsBp, mirrorSizeUsd),
        after: { outcome: 'exchange_error', message: orderError, response: res.response, nonce },
      });
      return { kind: 'exchange_error', cloid, message: orderError };
    }
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
    await submitTriggers({
      decision,
      entryCloid: cloid,
      entryPx: orderIntent.limitPx,
      nonce: deps.nonce,
      signer: deps.signer,
      transport: deps.transport,
      audit: deps.audit,
      user,
      subscription,
    });
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

/**
 * Best-effort take-profit + stop-loss submission. Runs AFTER a successful
 * entry; failures are logged via audit and never bubble up — the entry is
 * already filled and the user can manage manually if a trigger fails.
 *
 * Trigger cloids are derived deterministically from the entry cloid
 * (last byte → 0x01 for TP, 0x02 for SL) so that consumer retries
 * of the same fill produce the same trigger cloid — HL dedupes.
 */
interface SubmitTriggersInput {
  readonly decision: Extract<MirrorDecision, { kind: 'submit' }>;
  readonly entryCloid: `0x${string}`;
  readonly entryPx: string;
  readonly nonce: () => number;
  readonly signer: AgentSigner;
  readonly transport: Pick<HttpHlTransport, 'exchange'>;
  readonly audit: AuditSink;
  readonly user: UserSnapshot;
  readonly subscription: SubscriptionSnapshot;
}

async function submitTriggers(input: SubmitTriggersInput): Promise<void> {
  const { subscription, decision, entryPx, user } = input;
  const tasks: { kind: 'tp' | 'sl'; offsetBps: number }[] = [];
  if (subscription.tpBps !== null && subscription.tpBps > 0) {
    tasks.push({ kind: 'tp', offsetBps: subscription.tpBps });
  }
  if (subscription.slBps !== null && subscription.slBps > 0) {
    tasks.push({ kind: 'sl', offsetBps: subscription.slBps });
  }
  if (tasks.length === 0) return;

  const entry = decision.orderIntent;
  const side: 'B' | 'S' = entry.isBuy ? 'B' : 'S';
  const builderAddress = decision.action.builder.b;

  for (const t of tasks) {
    try {
      const triggerPx = computeTriggerPx({
        side,
        entryPx,
        offsetBps: t.offsetBps,
        kind: t.kind,
      });
      const triggerCloid = deriveTriggerCloid(input.entryCloid, t.kind);
      const action = buildTriggerOrderAction({
        intent: {
          asset: entry.asset,
          isBuy: !entry.isBuy,
          limitPx: triggerPx,
          sz: entry.sz,
          reduceOnly: true,
          tif: 'Gtc',
          cloid: triggerCloid,
        },
        triggerPx,
        kind: t.kind,
        isMarket: true,
        builderAddress,
        requestedFeeTenthsBp: user.currentFeeTenthsBp,
        userApprovedMaxFeeTenthsBp: user.approvedMaxFeeTenthsBp,
      });
      const nonce = input.nonce();
      const signature = await input.signer.sign({
        userId: user.id,
        agentAddress: user.agentAddress,
        action,
        nonce,
      });
      const res: HlExchangeResponseOk = await input.transport.exchange({
        action,
        signature,
        nonce,
      });
      await input.audit.appendAudit({
        actor: `op:${user.id}`,
        action: 'mirror.trigger',
        target: `cloid:${triggerCloid}`,
        before: { entryCloid: input.entryCloid, kind: t.kind, offsetBps: t.offsetBps },
        after: { outcome: 'submitted', triggerPx, response: res.response },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await input.audit.appendAudit({
        actor: `op:${user.id}`,
        action: 'mirror.trigger',
        target: `cloid:${input.entryCloid}-${t.kind}`,
        before: { entryCloid: input.entryCloid, kind: t.kind, offsetBps: t.offsetBps },
        after: { outcome: 'failed', message },
      });
    }
  }
}

function deriveTriggerCloid(entryCloid: `0x${string}`, kind: 'tp' | 'sl'): `0x${string}` {
  // entryCloid is `0x` + 32 hex chars. Replace the last byte (2 hex chars)
  // with a per-kind tag. Keeps 120 bits of entropy — plenty for HL dedupe
  // and avoids collision with the entry cloid itself.
  const tag = kind === 'tp' ? '01' : '02';
  return `0x${entryCloid.slice(2, 32)}${tag}`;
}

// HL's /exchange wraps per-order results inside status:"ok". An order can be
// rejected (insufficient margin, builder fee missing, agent invalid, ...) and
// still return ok at the envelope level — the failure lives in
// response.data.statuses[i].error. Treat any such entry as exchange_error so
// we never record a phantom fill or notify the user about an order HL refused.
function extractOrderError(response: HlExchangeResponseOk['response']): string | undefined {
  if (response.type !== 'order') return undefined;
  const data = response.data as { statuses?: unknown } | undefined;
  const statuses = data?.statuses;
  if (!Array.isArray(statuses)) return undefined;
  const errors: string[] = [];
  for (const s of statuses) {
    if (s !== null && typeof s === 'object' && 'error' in s) {
      const e = (s as { error: unknown }).error;
      if (typeof e === 'string') errors.push(e);
    }
  }
  return errors.length > 0 ? errors.join('; ') : undefined;
}
