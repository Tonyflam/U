/**
 * Just-in-time leverage syncer.
 *
 * HL persists leverage per (wallet, asset) server-side and applies it to
 * the NEXT order. Our /setlev stores a per-(user, whale) cap in the DB,
 * but the user's HL account knows nothing about it until we call
 * `updateLeverage`. So right before each mirror entry, we send an
 * updateLeverage for (user's wallet, asset, cap) — but only when the
 * value differs from what we last sent, to avoid an extra signed request
 * on every mirror.
 *
 * Cache is in-memory: keyed by `${userId}:${asset}`. Cleared on bot
 * restart, which costs one extra updateLeverage call per (user, asset)
 * after a deploy — harmless. We deliberately do NOT persist the cache:
 * if HL drops state (extremely rare) or the user manually changes their
 * leverage in the HL UI, the next mirror re-syncs anyway because our
 * cap is the source of truth.
 *
 * Failures are non-fatal. If updateLeverage fails (transport error,
 * exchange rejection, signer error), we log and continue with the order
 * at HL's current leverage. Worst case the user gets one trade at the
 * wrong leverage — better than blocking the entry entirely. The retry
 * happens automatically on the next mirror because cache stays
 * untouched on failure.
 */
import type { Address } from '@whalepod/schema';
import { buildUpdateLeverageAction, type HttpHlTransport } from '@whalepod/sdk';
import type { Logger } from 'pino';
import type { AgentSigner } from './submitMirror.js';

export interface LeverageSyncer {
  ensure(input: {
    readonly userId: string;
    readonly agentAddress: Address;
    readonly asset: number;
    readonly leverage: number;
  }): Promise<void>;
}

export interface KmsLeverageSyncerDeps {
  readonly signer: AgentSigner;
  readonly transport: Pick<HttpHlTransport, 'exchange'>;
  readonly nonce: () => number;
  readonly log: Logger;
}

export class KmsLeverageSyncer implements LeverageSyncer {
  private readonly cache = new Map<string, number>();
  constructor(private readonly deps: KmsLeverageSyncerDeps) {}

  async ensure(input: {
    readonly userId: string;
    readonly agentAddress: Address;
    readonly asset: number;
    readonly leverage: number;
  }): Promise<void> {
    const key = `${input.userId}:${input.asset.toString()}`;
    if (this.cache.get(key) === input.leverage) return;
    const action = buildUpdateLeverageAction({
      asset: input.asset,
      leverage: input.leverage,
      isCross: true,
    });
    const nonce = this.deps.nonce();
    try {
      const signature = await this.deps.signer.sign({
        userId: input.userId,
        agentAddress: input.agentAddress,
        action,
        nonce,
      });
      const res = await this.deps.transport.exchange({
        action,
        signature,
        nonce,
      });
      // Transport throws on HTTP / status:err, so reaching here means HL
      // accepted the update. Cache so we don't re-sign on every mirror.
      this.cache.set(key, input.leverage);
      this.deps.log.info(
        { userId: input.userId, asset: input.asset, leverage: input.leverage, res },
        'leverage.sync.ok',
      );
    } catch (err) {
      this.deps.log.warn(
        { err, userId: input.userId, asset: input.asset, leverage: input.leverage },
        'leverage.sync.failed',
      );
    }
  }
}
