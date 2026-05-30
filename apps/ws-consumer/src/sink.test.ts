import { describe, expect, it } from 'vitest';
import { InMemoryIntentSink } from './sink.js';
import type { MirrorIntent } from './types.js';

const intent = (key: string): MirrorIntent => ({
  idempotencyKey: key,
  subscriberId: '11111111-1111-1111-1111-111111111111',
  whaleFillId: 'fill-1',
  whaleAddress: '0x1111222233334444555566667777888899990000',
  coin: 'BTC',
  side: 'B',
  px: '50000',
  sz: '0.1',
  whaleTs: 1,
  emittedAt: 2,
});

describe('InMemoryIntentSink', () => {
  it('records new intents and returns true', async () => {
    const sink = new InMemoryIntentSink();
    expect(await sink.emit(intent('a'))).toBe(true);
    expect(await sink.emit(intent('b'))).toBe(true);
    expect(sink.recorded).toHaveLength(2);
  });

  it('returns false on duplicate idempotency key and does not re-record', async () => {
    const sink = new InMemoryIntentSink();
    expect(await sink.emit(intent('dup'))).toBe(true);
    expect(await sink.emit(intent('dup'))).toBe(false);
    expect(sink.recorded).toHaveLength(1);
  });
});
