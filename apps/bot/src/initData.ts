/**
 * Telegram WebApp init-data verification.
 *
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key       = HMAC-SHA256(key="WebAppData", message=bot_token)
 *   data_check_string = "\n".join(sorted("{key}={value}" for k,v in fields if k != "hash"))
 *   expected_hash    = HMAC-SHA256(secret_key, data_check_string)  // hex
 *
 * Signature is valid iff constant-time-equals(hash_field, expected_hash).
 *
 * Why this is security-critical: every authenticated request from the
 * mini-app to the bot/api carries this `tgWebAppData` URL fragment. Anyone
 * who can forge it can impersonate any Telegram user, including swapping
 * `user.id` to attack a different account. A timing-side-channel-safe equals
 * is therefore mandatory.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface InitDataUser {
  readonly id: bigint;
  readonly is_bot?: boolean | undefined;
  readonly first_name?: string | undefined;
  readonly last_name?: string | undefined;
  readonly username?: string | undefined;
  readonly language_code?: string | undefined;
}

export interface ParsedInitData {
  readonly user: InitDataUser;
  readonly auth_date: number;
  readonly query_id?: string;
  readonly start_param?: string;
  readonly raw: Readonly<Record<string, string>>;
}

const UserSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

export interface VerifyInitDataParams {
  readonly initData: string;
  readonly botToken: string;
  /** Reject if `auth_date` is older than this. Default 24h. */
  readonly maxAgeSeconds?: number;
  /** Pinned for tests. Default `() => Date.now()`. */
  readonly now?: () => number;
}

export type VerifyInitDataResult =
  | { readonly ok: true; readonly data: ParsedInitData }
  | { readonly ok: false; readonly reason: VerifyInitDataFailure };

export type VerifyInitDataFailure =
  | 'missing_hash'
  | 'bad_hash'
  | 'missing_user'
  | 'invalid_user'
  | 'expired'
  | 'missing_auth_date';

export function verifyInitData(params: VerifyInitDataParams): VerifyInitDataResult {
  const raw = parseQuery(params.initData);
  const hash = raw['hash'];
  if (!hash) return { ok: false, reason: 'missing_hash' };

  const dataCheckString = Object.keys(raw)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${raw[k] ?? ''}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(params.botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!constantTimeHexEqual(expected, hash)) {
    return { ok: false, reason: 'bad_hash' };
  }

  const authDateStr = raw['auth_date'];
  if (!authDateStr) return { ok: false, reason: 'missing_auth_date' };
  const authDate = Number(authDateStr);
  const now = (params.now ?? (() => Date.now()))() / 1000;
  const maxAge = params.maxAgeSeconds ?? 24 * 3600;
  if (now - authDate > maxAge) return { ok: false, reason: 'expired' };

  const userStr = raw['user'];
  if (!userStr) return { ok: false, reason: 'missing_user' };
  let user: InitDataUser;
  try {
    const parsed: unknown = JSON.parse(userStr);
    user = UserSchema.parse(parsed);
  } catch {
    return { ok: false, reason: 'invalid_user' };
  }

  return {
    ok: true,
    data: {
      user,
      auth_date: authDate,
      ...(raw['query_id'] !== undefined ? { query_id: raw['query_id'] } : {}),
      ...(raw['start_param'] !== undefined ? { start_param: raw['start_param'] } : {}),
      raw,
    },
  };
}

function parseQuery(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(part)] = '';
    } else {
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1));
      out[k] = v;
    }
  }
  return out;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Helper to build a valid initData string for tests. Production code MUST
 * NOT call this — the only legitimate producer is the Telegram client.
 */
export function signInitDataForTest(fields: Record<string, string>, botToken: string): string {
  const entries = Object.entries(fields);
  const dataCheckString = entries
    .slice()
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams();
  for (const [k, v] of entries) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}
