import { describe, expect, it } from 'vitest';
import { fanOutFill, type Subscriber } from './fanout.js';
import type { HlFillEvent } from './types.js';

const WHALE = '0x1111222233334444555566667777888899990000';
const OTHER_WHALE = '0xaaaa222233334444555566667777888899990000';

const fill: HlFillEvent = {
  hash: 'fill-001',
  oid: 1,
  user: WHALE,
  coin: 'BTC',
  side: 'B',
  px: '50000',
  sz: '0.1',
  time: 1_700_000_000_000,
};

const u1 = '11111111-1111-1111-1111-111111111111';
const u2 = '22222222-2222-2222-2222-222222222222';
const u3 = '33333333-3333-3333-3333-333333333333';

describe('fanOutFill', () => {
  it('emits one intent per eligible subscriber', () => {
    const subs: Subscriber[] = [
      { id: u1, whaleAddress: WHALE, paused: false, killSwitch: false },
      { id: u2, whaleAddress: WHALE, paused: false, killSwitch: false },
    ];
    const intents = fanOutFill(fill, subs, 1_700_000_000_100);
    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.subscriberId).sort()).toEqual([u1, u2]);
  });

  it('skips paused subscriptions', () => {
    const subs: Subscriber[] = [
      { id: u1, whaleAddress: WHALE, paused: true, killSwitch: false },
      { id: u2, whaleAddress: WHALE, paused: false, killSwitch: false },
    ];
    const intents = fanOutFill(fill, subs, 1);
    expect(intents.map((i) => i.subscriberId)).toEqual([u2]);
  });

  it('skips users with kill_switch=true', () => {
    const subs: Subscriber[] = [
      { id: u1, whaleAddress: WHALE, paused: false, killSwitch: true },
      { id: u2, whaleAddress: WHALE, paused: false, killSwitch: false },
    ];
    const intents = fanOutFill(fill, subs, 1);
    expect(intents.map((i) => i.subscriberId)).toEqual([u2]);
  });

  it('skips subscribers tracking a different whale', () => {
    const subs: Subscriber[] = [
      { id: u1, whaleAddress: OTHER_WHALE, paused: false, killSwitch: false },
      { id: u2, whaleAddress: WHALE, paused: false, killSwitch: false },
    ];
    const intents = fanOutFill(fill, subs, 1);
    expect(intents.map((i) => i.subscriberId)).toEqual([u2]);
  });

  it('produces idempotency keys of form `{whale_fill_id}:{subscriber_id}`', () => {
    const subs: Subscriber[] = [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }];
    const [intent] = fanOutFill(fill, subs, 1);
    expect(intent?.idempotencyKey).toBe(`fill-001:${u1}`);
  });

  it('preserves whale-fill fields verbatim (no operator-injected mutation)', () => {
    const subs: Subscriber[] = [{ id: u1, whaleAddress: WHALE, paused: false, killSwitch: false }];
    const [intent] = fanOutFill(fill, subs, 1_700_000_000_999);
    expect(intent?.coin).toBe(fill.coin);
    expect(intent?.side).toBe(fill.side);
    expect(intent?.px).toBe(fill.px);
    expect(intent?.sz).toBe(fill.sz);
    expect(intent?.whaleAddress).toBe(fill.user);
    expect(intent?.whaleFillId).toBe(fill.hash);
    expect(intent?.whaleTs).toBe(fill.time);
    expect(intent?.emittedAt).toBe(1_700_000_000_999);
  });

  it('returns [] when no subscribers eligible', () => {
    expect(fanOutFill(fill, [], 1)).toEqual([]);
    const allPaused: Subscriber[] = [
      { id: u1, whaleAddress: WHALE, paused: true, killSwitch: false },
      { id: u2, whaleAddress: WHALE, paused: false, killSwitch: true },
      { id: u3, whaleAddress: OTHER_WHALE, paused: false, killSwitch: false },
    ];
    expect(fanOutFill(fill, allPaused, 1)).toEqual([]);
  });
});
