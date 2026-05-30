import { z } from 'zod';

/**
 * Ethereum address — 0x + 40 hex chars. Normalizes to lowercase.
 *
 * EIP-55 checksum validation is deliberately NOT done here. That belongs at
 * the input boundary (miniapp API) where the caller can re-derive checksum
 * from the raw user input. Storage is always lowercase to give us a single
 * canonical form for equality checks and indexes.
 */
export const Address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid 0x address')
  .transform((s) => s.toLowerCase());

export type Address = z.infer<typeof Address>;

/** Hyperliquid coin ticker, e.g. "BTC", "ETH", "SOL". Uppercase, 1-20 chars. */
export const Coin = z.string().regex(/^[A-Z0-9]{1,20}$/, 'Invalid coin ticker');

/** Order side. */
export const Side = z.enum(['B', 'S']);

/** Builder fee in tenths of a basis point. 50 = 0.05% = 5 bps. */
export const FeeTenthsBp = z.number().int().min(0).max(100);

/** Telegram numeric user id. Accepts string for JSON-over-HTTP transport. */
export const TgUserId = z.coerce.bigint().positive();
