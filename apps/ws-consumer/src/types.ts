import { z } from 'zod';
import { Address, Coin, Side } from '@whalepod/schema';

/**
 * Hyperliquid `userFills` event shape (subset we depend on).
 *
 * Source: HL WS API. We deliberately accept a small superset (extra fields
 * are ignored by zod's default `.passthrough` is NOT used — we use strict
 * `.strip` and validate every field we read).
 */
export const HlFillEvent = z.object({
  /** Stable HL fill id, used as the idempotency root. */
  hash: z.string().min(1),
  /**
   * HL order id. A single whale order can produce many partial fills (one
   * per maker order it crosses), each with a distinct `hash`/`tid` but the
   * SAME `oid`. We dedupe on (user, oid) at the WS source so a 50-line IOC
   * sweep becomes ONE mirror intent, not 50.
   */
  oid: z.number().int().nonnegative(),
  /** Trader wallet (lowercased). */
  user: Address,
  /** Coin ticker. */
  coin: Coin,
  /** "B" buy or "S" sell. */
  side: Side,
  /** Decimal-string price. */
  px: z.string().regex(/^\d+(\.\d+)?$/, 'invalid px'),
  /** Decimal-string size. */
  sz: z.string().regex(/^\d+(\.\d+)?$/, 'invalid sz'),
  /** Server-side timestamp (ms). */
  time: z.number().int().nonnegative(),
});
export type HlFillEvent = z.infer<typeof HlFillEvent>;

/**
 * The fan-out emission produced by the ws-consumer for one subscriber.
 *
 * Schema is the contract on the `mirror-intents` Redis stream consumed by
 * the Order Router (apps/bot). Field names match phase-2.md §5.3.
 */
export const MirrorIntent = z.object({
  /** Unique idempotency key: `${whale_fill_id}:${subscriber_id}`. */
  idempotencyKey: z.string().min(3),
  /** The user_id (UUID) of the subscriber to mirror this fill for. */
  subscriberId: z.string().uuid(),
  /** The source fill from the whale (HL hash). */
  whaleFillId: z.string().min(1),
  /** Whale wallet that produced the source fill. */
  whaleAddress: Address,
  /** Coin to trade. */
  coin: Coin,
  /** Side. */
  side: Side,
  /** Indicative price (decimal string). Used by Order Router for sanity checks. */
  px: z.string(),
  /** Indicative size (decimal string). Order Router re-derives per-user size. */
  sz: z.string(),
  /** Original whale-fill server timestamp (ms). */
  whaleTs: z.number().int().nonnegative(),
  /** Time the intent was emitted (ms). For latency measurement. */
  emittedAt: z.number().int().nonnegative(),
});
export type MirrorIntent = z.infer<typeof MirrorIntent>;

/**
 * Alert payload published to the `watch-fills` Redis stream for each
 * (whale fill × watcher) pair. Consumed by the bot's watch-notify consumer
 * which renders it into a Telegram ping with a "mirror this whale" CTA.
 *
 * Watchers have no `users` row (no wallet connected), so the stream entry
 * carries the Telegram user id alongside this payload — same envelope shape
 * as the `mirror-fills` stream.
 */
export const WatchFillEvent = z.object({
  /** HL fill hash — idempotency root, paired with the watcher's tg id. */
  fillHash: z.string().min(1),
  /** Whale wallet that produced the fill. */
  whaleAddress: Address,
  /** Optional curated/db alias for friendlier alert copy. */
  whaleAlias: z.string().min(1).max(64).nullable(),
  coin: Coin,
  side: Side,
  /** Decimal-string price. */
  px: z.string().regex(/^\d+(\.\d+)?$/u, 'invalid px'),
  /** Decimal-string size. */
  sz: z.string().regex(/^\d+(\.\d+)?$/u, 'invalid sz'),
  /** Whale-fill server timestamp (ms). */
  whaleTs: z.number().int().nonnegative(),
});
export type WatchFillEvent = z.infer<typeof WatchFillEvent>;
