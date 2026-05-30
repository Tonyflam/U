/**
 * HTTP transport for the Hyperliquid Exchange API.
 *
 * Responsibilities:
 *   - POST signed actions to `{baseUrl}/exchange` with the canonical envelope
 *     `{action, signature, nonce, vaultAddress?}`.
 *   - GET `/info` queries (mark price, user state, fills).
 *   - Parse HL's response envelope and surface typed errors.
 *
 * Non-responsibilities (deliberately):
 *   - Signing. Callers pass already-signed `{action, signature, nonce}`. The
 *     L1-action msgpack hash + agent-key signing lives in `signL1Action.ts`
 *     (separate unit).
 *   - Retry policy. HL's exchange endpoint is non-idempotent at the network
 *     layer; retrying a 5xx on POST can double-submit an order. The caller
 *     decides retry semantics with knowledge of the action kind.
 *   - Rate limiting. Adds latency and risks hiding real throttling from the
 *     caller. The order router enforces its own pacing.
 *
 * Security:
 *   - We pin the User-Agent so HL can identify us during outages.
 *   - We refuse non-https base URLs unless `allowInsecure: true` (only ever
 *     used by tests against `http://127.0.0.1`).
 *   - We timeout every request via `AbortController`; default 10s.
 */
import { HL_MAINNET_URL, HL_TESTNET_URL } from './constants.js';

/** Wire-format signature returned by viem `signTypedData` / `signMessage`. */
export interface HlSignature {
  readonly r: `0x${string}`;
  readonly s: `0x${string}`;
  readonly v: number;
}

/** Generic exchange request envelope. */
export interface HlExchangeRequest {
  readonly action: unknown;
  readonly signature: HlSignature;
  readonly nonce: number;
  readonly vaultAddress?: `0x${string}`;
}

/** HL's exchange response. `status: 'ok'` always, errors come back inline. */
export interface HlExchangeResponseOk {
  readonly status: 'ok';
  readonly response: {
    readonly type: string;
    readonly data?: unknown;
  };
}

export interface HlExchangeResponseErr {
  readonly status: 'err';
  readonly response: string;
}

export type HlExchangeResponse = HlExchangeResponseOk | HlExchangeResponseErr;

export class HlTransportError extends Error {
  override readonly name = 'HlTransportError';
  override readonly cause?: unknown;
  readonly httpStatus?: number;
  constructor(message: string, cause?: unknown, httpStatus?: number) {
    super(message);
    if (cause !== undefined) this.cause = cause;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export class HlExchangeError extends Error {
  override readonly name = 'HlExchangeError';
  constructor(readonly body: HlExchangeResponseErr) {
    super(`HL exchange error: ${body.response}`);
  }
}

export interface HttpHlTransportOptions {
  /** REST base. Use `HL_MAINNET_URL` or `HL_TESTNET_URL`. */
  readonly baseUrl: string;
  /** Per-request timeout, ms. Default 10000. */
  readonly timeoutMs?: number;
  /** User-Agent header. */
  readonly userAgent?: string;
  /** Allow http:// (tests only). */
  readonly allowInsecure?: boolean;
  /** Override `fetch` for tests. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_UA = 'WhalePod/1.0 (+https://whalepod.trade)';

export class HttpHlTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpHlTransportOptions) {
    if (!options.allowInsecure && !options.baseUrl.startsWith('https://')) {
      throw new HlTransportError(`Refusing non-https HL base URL: ${options.baseUrl}`);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** POST `/exchange` with a signed action. Throws `HlExchangeError` on 200 err body. */
  async exchange(req: HlExchangeRequest): Promise<HlExchangeResponseOk> {
    const body = await this.post('/exchange', req);
    const parsed = body as HlExchangeResponse;
    if (parsed.status === 'err') throw new HlExchangeError(parsed);
    return parsed;
  }

  /** POST `/info`. The body shape varies by query type. */
  async info<T = unknown>(query: Record<string, unknown>): Promise<T> {
    const body = await this.post('/info', query);
    return body as T;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.userAgent,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new HlTransportError(`POST ${path} failed: ${asMessage(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new HlTransportError(
        `POST ${path} returned HTTP ${String(res.status)}: ${text.slice(0, 200)}`,
        undefined,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new HlTransportError(
        `POST ${path} returned non-JSON body: ${text.slice(0, 200)}`,
        err,
        res.status,
      );
    }
  }
}

function asMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Helper: pick the URL for a network. */
export function hlBaseUrl(network: 'mainnet' | 'testnet'): string {
  return network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL;
}
