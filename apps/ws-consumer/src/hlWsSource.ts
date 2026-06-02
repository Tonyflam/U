/**
 * Hyperliquid `userFills` WebSocket source.
 *
 * Connects to `wss://api.hyperliquid.xyz/ws`, subscribes per whale, and
 * exposes the stream as `FillSource.events()` so the existing pure pipeline
 * (consumer.ts → fanout → sink) consumes upstream events unchanged.
 *
 * Responsibilities:
 *   - Subscribe to `{ type: 'userFills', user }` for every tracked whale.
 *   - Re-subscribe on reconnect (HL drops subscriptions on disconnect).
 *   - Exponential-backoff reconnect with full jitter (uses `backoffMs`).
 *   - Translate the wrapped HL message envelope `{ channel, data }` into
 *     individual fill events shaped like the existing `HlFillEvent` schema.
 *
 * Explicitly NOT done here:
 *   - Backfill of fills missed during the disconnect window. HL exposes
 *     `userFillsByTime` over HTTP — backfill belongs in a separate unit
 *     because it requires the same per-whale cursor we don't yet persist.
 *   - Dedupe. The downstream sink owns dedupe on the idempotency key, and
 *     a reconnect that re-delivers a fill is harmless.
 *
 * Tests inject `wsFactory` to avoid real sockets.
 */
import type { Logger } from 'pino';
import { backoffMs } from './backoff.js';
import type { FillSource } from './consumer.js';

/** Minimal interface a WS client must satisfy. Matches the `ws` package surface. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'pong', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | string) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  ping?(): void;
}

export type WsFactory = (url: string) => WsLike;

export interface HlWsSourceOptions {
  readonly url: string;
  /** Initial whale set. May be refreshed by calling `setWhales(...)`. */
  readonly whales: readonly string[];
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  readonly wsFactory: WsFactory;
  /** Backoff base for reconnects. Default 250ms. */
  readonly reconnectBaseMs?: number;
  /** Backoff cap for reconnects. Default 30s. */
  readonly reconnectMaxMs?: number;
  /** Heartbeat interval. Default 30s. Set 0 to disable. */
  readonly heartbeatMs?: number;
  /** Internal queue cap before backpressure-drops oldest. Default 10_000. */
  readonly bufferCap?: number;
}

const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_BUFFER_CAP = 10_000;

interface SubMsg {
  readonly method: 'subscribe' | 'unsubscribe';
  readonly subscription: { readonly type: 'userFills'; readonly user: string };
}

interface HlWsEnvelope {
  readonly channel: string;
  readonly data: unknown;
}

interface UserFillsPayload {
  readonly user: string;
  readonly fills: readonly unknown[];
  readonly isSnapshot?: boolean;
}

export class HlWebSocketSource implements FillSource {
  private readonly options: Required<Omit<HlWsSourceOptions, 'whales'>> & {
    whales: Set<string>;
  };
  private ws: WsLike | undefined;
  private connected = false;
  private stopped = false;
  private attempt = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** Buffer of pending events the iterator hasn't drained yet. */
  private readonly buffer: unknown[] = [];
  /** Pending iterator pulls. Resolved when an event arrives or stop. */
  private readonly waiters: ((r: IteratorResult<unknown>) => void)[] = [];
  /** Bookkeeping: every fill we've already published (per process), to dedupe
   *  the re-delivery a reconnect triggers via the userFills snapshot. */
  private readonly seenFillHashes = new Set<string>();

  constructor(options: HlWsSourceOptions) {
    this.options = {
      url: options.url,
      whales: new Set(options.whales.map((w) => w.toLowerCase())),
      logger: options.logger,
      wsFactory: options.wsFactory,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_BASE_MS,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULT_MAX_MS,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      bufferCap: options.bufferCap ?? DEFAULT_BUFFER_CAP,
    };
  }

  /** Open the socket and start pumping events. Idempotent. */
  start(): void {
    if (this.stopped) throw new Error('HlWebSocketSource: cannot restart after stop()');
    if (this.ws !== undefined) return;
    this.connect();
  }

  /** Gracefully shut down. Resolves outstanding iterator pulls with done. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.connected = false;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  /** Replace the tracked whale set. Diffs sub/unsub on the live socket. */
  setWhales(whales: readonly string[]): void {
    const next = new Set(whales.map((w) => w.toLowerCase()));
    const prev = this.options.whales;
    if (this.connected && this.ws !== undefined) {
      for (const w of prev) {
        if (!next.has(w)) this.sendSub('unsubscribe', w);
      }
      for (const w of next) {
        if (!prev.has(w)) this.sendSub('subscribe', w);
      }
    }
    this.options.whales = next;
  }

  events(): AsyncIterable<unknown> {
    const pull = (): Promise<IteratorResult<unknown>> => this.pull();
    const stop = (): void => {
      this.stop();
    };
    return {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next(): Promise<IteratorResult<unknown>> {
            return pull();
          },
          return(): Promise<IteratorResult<unknown>> {
            stop();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  private pull(): Promise<IteratorResult<unknown>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift();
      return Promise.resolve({ value, done: false });
    }
    if (this.stopped) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<unknown>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private push(ev: unknown): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) {
        w({ value: ev, done: false });
        return;
      }
    }
    if (this.buffer.length >= this.options.bufferCap) {
      this.buffer.shift();
      this.options.logger.warn(
        { cap: this.options.bufferCap },
        'ws-consumer: buffer overflow, dropping oldest',
      );
    }
    this.buffer.push(ev);
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.logger.info({ url: this.options.url }, 'ws-consumer: connecting');
    let ws: WsLike;
    try {
      ws = this.options.wsFactory(this.options.url);
    } catch (err) {
      this.options.logger.error({ err }, 'ws-consumer: ws factory threw');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.options.logger.info('ws-consumer: open');
      for (const w of this.options.whales) this.sendSub('subscribe', w);
      this.startHeartbeat();
    });
    ws.on('message', (raw) => {
      this.onMessage(raw);
    });
    ws.on('close', (code) => {
      this.options.logger.warn({ code }, 'ws-consumer: closed');
      this.onDisconnect();
    });
    ws.on('error', (err) => {
      this.options.logger.error({ err: err.message }, 'ws-consumer: error');
    });
  }

  private onDisconnect(): void {
    this.connected = false;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.ws = undefined;
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = backoffMs(this.attempt, {
      baseMs: this.options.reconnectBaseMs,
      maxMs: this.options.reconnectMaxMs,
    });
    this.attempt += 1;
    this.options.logger.info({ delay, attempt: this.attempt }, 'ws-consumer: reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.options.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ method: 'ping' }));
      } catch (err) {
        this.options.logger.warn({ err }, 'ws-consumer: heartbeat send failed');
      }
    }, this.options.heartbeatMs);
  }

  private sendSub(method: SubMsg['method'], user: string): void {
    if (this.ws === undefined) return;
    const msg: SubMsg = { method, subscription: { type: 'userFills', user } };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.options.logger.warn({ err, user, method }, 'ws-consumer: subscribe send failed');
    }
  }

  private onMessage(raw: Buffer | ArrayBuffer | string): void {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
    let env: HlWsEnvelope;
    try {
      env = JSON.parse(text) as HlWsEnvelope;
    } catch (err) {
      this.options.logger.warn({ err, text: text.slice(0, 120) }, 'ws-consumer: non-JSON');
      return;
    }
    if (env.channel === 'pong') return;
    if (env.channel === 'subscriptionResponse') return;
    if (env.channel !== 'userFills') return;
    const payload = env.data as UserFillsPayload | undefined;
    if (!payload || !Array.isArray(payload.fills)) return;
    const user = payload.user.toLowerCase();
    for (const f of payload.fills) {
      const evt = this.normalizeFill(f, user);
      if (evt === undefined) continue;
      // Dedupe by (user, oid): partial fills of the same whale order share
      // an oid but have distinct hashes. We want ONE mirror per whale order.
      const oid = (evt as { oid?: number }).oid;
      const dedupeKey =
        typeof oid === 'number' ? `${user}:${oid.toString()}` : (evt as { hash?: string }).hash;
      if (typeof dedupeKey === 'string') {
        if (this.seenFillHashes.has(dedupeKey)) continue;
        this.seenFillHashes.add(dedupeKey);
      }
      this.push(evt);
    }
  }

  /** Map HL's per-fill shape to the `HlFillEvent` schema (parsed downstream). */
  private normalizeFill(raw: unknown, user: string): unknown {
    if (raw === null || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const hash = pickString(r['hash']);
    const coin = pickString(r['coin']);
    const sideRaw = pickString(r['side']);
    const px = pickString(r['px']);
    const sz = pickString(r['sz']);
    const time = typeof r['time'] === 'number' ? r['time'] : undefined;
    const oid = typeof r['oid'] === 'number' ? r['oid'] : undefined;
    if (hash === undefined || coin === undefined || sideRaw === undefined) return undefined;
    if (px === undefined || sz === undefined || time === undefined) return undefined;
    if (oid === undefined) return undefined;
    const side = sideRaw === 'A' ? 'S' : sideRaw === 'B' ? 'B' : sideRaw;
    return { hash, oid, user, coin, side, px, sz, time };
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
