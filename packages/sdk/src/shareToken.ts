/**
 * Tamper-evident token for trade-share OG cards. Encodes a small trade
 * summary into a URL-safe string signed with HMAC-SHA256 so the bot can
 * mint a link and the OG renderer (miniapp-web) can verify the payload
 * without an extra DB read.
 *
 * Wire format: `<base64url(json)>.<base64url(sigBytes)>`
 *   - json is the canonical JSON of the payload (no whitespace, keys in
 *     declared order)
 *   - sigBytes is `HMAC_SHA256(secret, json)`
 *
 * The secret is shared between the bot and miniapp-web via the
 * `SHARE_TOKEN_SECRET` env var. If they drift, verification fails closed
 * (the renderer falls back to the neutral card).
 *
 * Tokens are not encrypted — the trade payload is public-by-design (it's
 * about to be posted to Telegram). We only need integrity + authenticity
 * so a malicious sender can't fake "+$10k closed" with someone else's
 * referral handle.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TradeSharePayload {
  /** Referral code so the recipient lands on the inviter's deep link. */
  readonly code: string;
  /** Coin symbol (e.g. 'BTC', 'ETH'). */
  readonly coin: string;
  /** Side of the position that was closed: 'long' or 'short'. */
  readonly side: 'long' | 'short';
  /** Absolute size closed, as decimal string (matches HL precision). */
  readonly sz: string;
  /** Volume-weighted entry price, decimal string. */
  readonly entryPx: string;
  /** Exit mark price at close, decimal string. */
  readonly exitPx: string;
  /** Realized PnL in USD (signed), decimal string. */
  readonly pnlUsd: string;
  /** Realized PnL in percent vs cost basis (signed), e.g. "8.12". */
  readonly pnlPct: string;
  /** Alias of the whale whose mirror trade this was (may be null). */
  readonly whaleAlias: string | null;
  /** Unix ms timestamp the trade closed. */
  readonly ts: number;
}

const FIELD_ORDER: readonly (keyof TradeSharePayload)[] = [
  'code',
  'coin',
  'side',
  'sz',
  'entryPx',
  'exitPx',
  'pnlUsd',
  'pnlPct',
  'whaleAlias',
  'ts',
];

function canonicalJson(p: TradeSharePayload): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) ordered[k] = p[k];
  return JSON.stringify(ordered);
}

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signTradeShare(payload: TradeSharePayload, secret: string): string {
  if (!secret) throw new Error('SHARE_TOKEN_SECRET required');
  const json = canonicalJson(payload);
  const jsonB64 = b64urlEncode(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(json, 'utf8').digest();
  return `${jsonB64}.${b64urlEncode(sig)}`;
}

export function verifyTradeShare(token: string, secret: string): TradeSharePayload | null {
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const jsonB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let json: string;
  let sig: Buffer;
  try {
    json = b64urlDecode(jsonB64).toString('utf8');
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret).update(json, 'utf8').digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPayload(parsed)) return null;
  return parsed;
}

function isPayload(v: unknown): v is TradeSharePayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['code'] === 'string' &&
    typeof o['coin'] === 'string' &&
    (o['side'] === 'long' || o['side'] === 'short') &&
    typeof o['sz'] === 'string' &&
    typeof o['entryPx'] === 'string' &&
    typeof o['exitPx'] === 'string' &&
    typeof o['pnlUsd'] === 'string' &&
    typeof o['pnlPct'] === 'string' &&
    (o['whaleAlias'] === null || typeof o['whaleAlias'] === 'string') &&
    typeof o['ts'] === 'number' &&
    Number.isFinite(o['ts'])
  );
}
