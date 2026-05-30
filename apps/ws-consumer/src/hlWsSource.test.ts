import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { HlWebSocketSource, type WsLike } from './hlWsSource.js';

type Listener = (...args: never[]) => void;

class FakeWs {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: (...args: never[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }
  send(data: string): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1000, Buffer.from(''));
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
}

function asWs(w: FakeWs): WsLike {
  return w as unknown as WsLike;
}

const silentLogger = pino({ level: 'silent' });

function nextTick(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HlWebSocketSource', () => {
  it('subscribes to userFills for every whale on open', () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xAAA', '0xBBB'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    expect(ws.sent).toHaveLength(2);
    const subs = ws.sent.map((s) => JSON.parse(s) as unknown);
    expect(subs).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'userFills', user: '0xaaa' },
    });
    expect(subs).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'userFills', user: '0xbbb' },
    });
    src.stop();
  });

  it('yields normalized fill events through the async iterator', async () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xabc'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    const it = src.events()[Symbol.asyncIterator]();
    ws.emit(
      'message',
      JSON.stringify({
        channel: 'userFills',
        data: {
          user: '0xABC',
          isSnapshot: false,
          fills: [
            { hash: 'h1', coin: 'BTC', side: 'B', px: '50000', sz: '0.1', time: 1700000000000 },
          ],
        },
      }),
    );
    const r = await it.next();
    expect(r.done).toBe(false);
    expect(r.value).toEqual({
      hash: 'h1',
      user: '0xabc',
      coin: 'BTC',
      side: 'B',
      px: '50000',
      sz: '0.1',
      time: 1700000000000,
    });
    src.stop();
  });

  it('deduplicates re-delivered fills with the same hash (snapshot replay)', async () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xabc'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    const it = src.events()[Symbol.asyncIterator]();
    const fill = {
      hash: 'dup-1',
      coin: 'ETH',
      side: 'S',
      px: '3000',
      sz: '1',
      time: 1700000000001,
    };
    ws.emit(
      'message',
      JSON.stringify({ channel: 'userFills', data: { user: '0xabc', fills: [fill] } }),
    );
    ws.emit(
      'message',
      JSON.stringify({
        channel: 'userFills',
        data: { user: '0xabc', isSnapshot: true, fills: [fill] },
      }),
    );
    const r1 = await it.next();
    expect((r1.value as { hash: string }).hash).toBe('dup-1');
    let resolved = false;
    void it.next().then(() => {
      resolved = true;
    });
    await nextTick();
    expect(resolved).toBe(false);
    src.stop();
  });

  it('drops invalid envelopes and unrelated channels without throwing', async () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xabc'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    ws.emit('message', 'not-json');
    ws.emit('message', JSON.stringify({ channel: 'l2Book', data: {} }));
    ws.emit(
      'message',
      JSON.stringify({ channel: 'userFills', data: { user: '0xabc', fills: [{ hash: 'bad' }] } }),
    );
    ws.emit('message', JSON.stringify({ channel: 'pong', data: {} }));
    const it = src.events()[Symbol.asyncIterator]();
    let resolved = false;
    void it.next().then(() => {
      resolved = true;
    });
    await nextTick();
    expect(resolved).toBe(false);
    src.stop();
  });

  it('reconnects with backoff and re-subscribes on open', () => {
    const sockets: FakeWs[] = [];
    const factory = vi.fn(() => {
      const w = new FakeWs();
      sockets.push(w);
      return asWs(w);
    });
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xabc'],
      logger: silentLogger,
      wsFactory: factory,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      heartbeatMs: 0,
    });
    src.start();
    const w0 = sockets[0]!;
    w0.emit('open');
    expect(w0.sent).toHaveLength(1);
    w0.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(50);
    expect(sockets.length).toBe(2);
    const w1 = sockets[1]!;
    w1.emit('open');
    expect(w1.sent).toHaveLength(1);
    src.stop();
  });

  it('setWhales sub/unsubs the diff on the live socket', () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xaaa', '0xbbb'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    ws.sent.length = 0;
    src.setWhales(['0xbbb', '0xccc']);
    const parsed = ws.sent.map(
      (s) => JSON.parse(s) as { method: string; subscription: { user: string } },
    );
    expect(parsed).toContainEqual({
      method: 'unsubscribe',
      subscription: { type: 'userFills', user: '0xaaa' },
    });
    expect(parsed).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'userFills', user: '0xccc' },
    });
    src.stop();
  });

  it('sends heartbeat pings on the configured interval', () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xaaa'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 1000,
    });
    src.start();
    ws.emit('open');
    ws.sent.length = 0;
    vi.advanceTimersByTime(1000);
    expect(ws.sent[0]).toBe(JSON.stringify({ method: 'ping' }));
    src.stop();
  });

  it('stop() resolves pending pulls with done', async () => {
    const ws = new FakeWs();
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: ['0xaaa'],
      logger: silentLogger,
      wsFactory: () => asWs(ws),
      heartbeatMs: 0,
    });
    src.start();
    ws.emit('open');
    const it = src.events()[Symbol.asyncIterator]();
    const p = it.next();
    src.stop();
    const r = await p;
    expect(r.done).toBe(true);
  });

  it('refuses to restart after stop()', () => {
    const src = new HlWebSocketSource({
      url: 'wss://test/ws',
      whales: [],
      logger: silentLogger,
      wsFactory: () => asWs(new FakeWs()),
      heartbeatMs: 0,
    });
    src.start();
    src.stop();
    expect(() => {
      src.start();
    }).toThrow(/cannot restart/u);
  });
});
