/* eslint-disable no-restricted-globals, @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import {
  HttpHlTransport,
  HlExchangeError,
  HlTransportError,
  hlBaseUrl,
  type HlSignature,
} from './transport.js';
import { HL_MAINNET_URL, HL_TESTNET_URL } from './constants.js';

const SIG: HlSignature = {
  r: '0x1111111111111111111111111111111111111111111111111111111111111111',
  s: '0x2222222222222222222222222222222222222222222222222222222222222222',
  v: 27,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchFn = typeof fetch;
function makeFetch(impl: FetchFn) {
  return vi.fn(impl);
}

describe('hlBaseUrl', () => {
  it('maps mainnet and testnet', () => {
    expect(hlBaseUrl('mainnet')).toBe(HL_MAINNET_URL);
    expect(hlBaseUrl('testnet')).toBe(HL_TESTNET_URL);
  });
});

describe('HttpHlTransport constructor', () => {
  it('refuses non-https base URL by default', () => {
    expect(() => new HttpHlTransport({ baseUrl: 'http://example.com' })).toThrow(HlTransportError);
  });
  it('allows http when allowInsecure is set (tests only)', () => {
    expect(
      () => new HttpHlTransport({ baseUrl: 'http://127.0.0.1:8080', allowInsecure: true }),
    ).not.toThrow();
  });
  it('strips trailing slashes from baseUrl', async () => {
    const fetchImpl = makeFetch(async () =>
      jsonResponse({ status: 'ok', response: { type: 'order' } }),
    );
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz///',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.exchange({ action: { type: 'order' }, signature: SIG, nonce: 1 });
    const call = fetchImpl.mock.calls[0];
    const url = (call?.[0] ?? '') as string;
    expect(url).toBe('https://api.hyperliquid.xyz/exchange');
  });
});

describe('HttpHlTransport.exchange', () => {
  it('POSTs to /exchange with the canonical envelope', async () => {
    const fetchImpl = makeFetch(async () =>
      jsonResponse({ status: 'ok', response: { type: 'order', data: { ok: true } } }),
    );
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await t.exchange({
      action: { type: 'order', orders: [] },
      signature: SIG,
      nonce: 42,
    });
    expect(res.status).toBe('ok');
    const call = fetchImpl.mock.calls[0];
    const init = call?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      action: { type: 'order', orders: [] },
      signature: SIG,
      nonce: 42,
    });
  });

  it('throws HlExchangeError on err body', async () => {
    const fetchImpl = makeFetch(async () =>
      jsonResponse({ status: 'err', response: 'insufficient margin' }),
    );
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      t.exchange({ action: { type: 'order' }, signature: SIG, nonce: 1 }),
    ).rejects.toBeInstanceOf(HlExchangeError);
  });

  it('throws HlTransportError on non-2xx HTTP', async () => {
    const fetchImpl = makeFetch(async () => new Response('upstream down', { status: 503 }));
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await t
      .exchange({ action: { type: 'order' }, signature: SIG, nonce: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlTransportError);
    expect((err as HlTransportError).httpStatus).toBe(503);
  });

  it('throws HlTransportError on non-JSON body', async () => {
    const fetchImpl = makeFetch(async () => new Response('not json', { status: 200 }));
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      t.exchange({ action: { type: 'order' }, signature: SIG, nonce: 1 }),
    ).rejects.toBeInstanceOf(HlTransportError);
  });

  it('aborts requests that exceed timeout', async () => {
    const fetchImpl = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      t.exchange({ action: { type: 'order' }, signature: SIG, nonce: 1 }),
    ).rejects.toBeInstanceOf(HlTransportError);
  });
});

describe('HttpHlTransport.info', () => {
  it('POSTs the query body to /info and returns the parsed JSON', async () => {
    const fetchImpl = makeFetch(async () => jsonResponse({ markPx: '50000.0' }));
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await t.info<{ markPx: string }>({ type: 'l2Book', coin: 'BTC' });
    expect(out.markPx).toBe('50000.0');
    const call = fetchImpl.mock.calls[0];
    const url = (call?.[0] ?? '') as string;
    expect(url).toBe('https://api.hyperliquid.xyz/info');
  });
});

describe('User-Agent', () => {
  it('sends a pinned User-Agent', async () => {
    const fetchImpl = makeFetch(async () =>
      jsonResponse({ status: 'ok', response: { type: 'order' } }),
    );
    const t = new HttpHlTransport({
      baseUrl: 'https://api.hyperliquid.xyz',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await t.exchange({ action: {}, signature: SIG, nonce: 1 });
    const call = fetchImpl.mock.calls[0];
    const init = call?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ua = headers['user-agent'] ?? '';
    expect(ua).toMatch(/WhalePod/u);
  });
});
