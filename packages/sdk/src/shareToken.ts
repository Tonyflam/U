/**
 * Tamper-evident token for trade-share OG cards. Encodes a small trade
 * summary into a URL-safe string signed with HMAC-SHA256 so the bot can
 * mint a link and the OG renderer (miniapp-web) can verify the payload
 * without an extra DB read.
 *
 * Wire format: `<base64url(json)>.<base64url(sigBytes)>`
 *   - json is canonical compact JSON using SHORT keys (declared order) so
 *     the encoded URL stays under ~200 chars — Telegram share buttons get
 *     ugly fast above that. Public TS API still uses readable field names.
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

// Short-key encoding on the wire. Single chars where possible. `w` is
// omitted entirely when whaleAlias is null to save ~10 chars.
interface Wire {
  c: string;
  o: string;
  s: 'L' | 'S';
  z: string;
  e: string;
  x: string;
  p: string;
  q: string;
  w?: string;
  t: number;
}

function toWire(p: TradeSharePayload): Wire {
  const w: Wire = {
    c: p.code,
    o: p.coin,
    s: p.side === 'long' ? 'L' : 'S',
    z: p.sz,
    e: p.entryPx,
    x: p.exitPx,
    p: p.pnlUsd,
    q: p.pnlPct,
    t: p.ts,
  };
  if (p.whaleAlias !== null) w.w = p.whaleAlias;
  return w;
}

function fromWire(w: Wire): TradeSharePayload {
  return {
    code: w.c,
    coin: w.o,
    side: w.s === 'L' ? 'long' : 'short',
    sz: w.z,
    entryPx: w.e,
    exitPx: w.x,
    pnlUsd: w.p,
    pnlPct: w.q,
    whaleAlias: w.w ?? null,
    ts: w.t,
  };
}

// Stable key order for canonical JSON. We build the literal explicitly so
// runtimes that don't preserve insertion order still produce identical bytes.
function canonicalJson(w: Wire): string {
  const o: Record<string, unknown> = {
    c: w.c,
    o: w.o,
    s: w.s,
    z: w.z,
    e: w.e,
    x: w.x,
    p: w.p,
    q: w.q,
  };
  if (w.w !== undefined) o['w'] = w.w;
  o['t'] = w.t;
  return JSON.stringify(o);
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
  const json = canonicalJson(toWire(payload));
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
  if (!isWire(parsed)) return null;
  return fromWire(parsed);
}

function isWire(v: unknown): v is Wire {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['c'] === 'string' &&
    typeof o['o'] === 'string' &&
    (o['s'] === 'L' || o['s'] === 'S') &&
    typeof o['z'] === 'string' &&
    typeof o['e'] === 'string' &&
    typeof o['x'] === 'string' &&
    typeof o['p'] === 'string' &&
    typeof o['q'] === 'string' &&
    (o['w'] === undefined || typeof o['w'] === 'string') &&
    typeof o['t'] === 'number' &&
    Number.isFinite(o['t'])
  );
}
