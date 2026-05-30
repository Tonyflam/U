/**
 * Adapter from the `ws` npm package to our `WsLike` interface.
 *
 * Kept thin so the consumer logic in `hlWsSource.ts` stays driver-agnostic
 * and unit-testable without sockets.
 */
import WebSocket from 'ws';
import type { WsLike } from './hlWsSource.js';

export function createWs(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}
