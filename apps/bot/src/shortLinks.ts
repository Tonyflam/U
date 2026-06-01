/**
 * Short-link store for trade-share URLs. The full HMAC token is ~200
 * chars after base64 + percent-encoding, which makes the t.me/share/url
 * button URL absurdly long. We mint an 8-char random id, store
 *   id -> token   (Redis, 30d TTL)
 * and the bot's share button uses `/s/<id>` instead of `/share/t/<token>`.
 * The miniapp's /s/[id] page resolves the id back to the token and
 * delegates to the same OG renderer.
 */
import type { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

const ID_LEN = 8; // ~47 bits, fine for short-lived share URLs
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0/O/1/I/l

export interface ShortLinkStore {
  /** Store `token` and return a short id. Idempotent only at the call site (random id). */
  put(token: string): Promise<string>;
  /** Resolve a short id back to the original token, or null if expired/unknown. */
  get(id: string): Promise<string | null>;
}

function key(id: string): string {
  return `slink:${id}`;
}

function randomId(): string {
  const bytes = randomBytes(ID_LEN);
  let out = '';
  for (let i = 0; i < ID_LEN; i++) {
    const byte = bytes[i] ?? 0;
    const ch = ALPHABET[byte % ALPHABET.length] ?? 'A';
    out += ch;
  }
  return out;
}

export class RedisShortLinkStore implements ShortLinkStore {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(opts: { readonly redis: Redis; readonly ttlSec?: number }) {
    this.redis = opts.redis;
    this.ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  }

  async put(token: string): Promise<string> {
    // Retry on (astronomically unlikely) collision so we never overwrite a
    // different valid token under the same id.
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = randomId();
      // `nx: true` makes SET a no-op if the key exists.
      const ok = await this.redis.set(key(id), token, { ex: this.ttlSec, nx: true });
      if (ok === 'OK') return id;
    }
    throw new Error('short-link id collision after retries');
  }

  async get(id: string): Promise<string | null> {
    const v = await this.redis.get<string>(key(id));
    return typeof v === 'string' ? v : null;
  }
}
