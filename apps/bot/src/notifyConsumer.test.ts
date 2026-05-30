import { describe, expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { handleEntry } from './notifyConsumer.js';

const SAMPLE_EVENT = {
  idempotencyKey: 'k-1',
  whaleAddress: '0xabcd000000000000000000000000000000000001',
  coin: 'ETH',
  side: 'B' as const,
  px: '3000',
  sz: '0.5',
  notionalUsd: '1500',
  builderFeeTenthsBp: 50,
  builderFeeUsd: '0.75',
  ts: 1_700_000_000_000,
};

function makeBot(): {
  sendMessage: ReturnType<typeof vi.fn>;
  bot: { api: { sendMessage: ReturnType<typeof vi.fn> } };
} {
  const sendMessage = vi.fn(() => Promise.resolve(undefined));
  return { sendMessage, bot: { api: { sendMessage } } };
}

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

describe('notifyConsumer handleEntry', () => {
  it('sends rendered notification to tg user', async () => {
    const { sendMessage, bot } = makeBot();
    await handleEntry(
      {
        id: '1-0',
        payload: JSON.stringify(SAMPLE_EVENT),
        tgUserId: '12345',
      },
      {
        redis: {} as never,
        bot: bot as unknown as Bot,
        log,
        consumerName: 'c1',
      },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0];
    expect(call?.[0]).toBe(12345);
    expect(String(call?.[1])).toMatch(/BUY/);
  });

  it('skips entries missing payload or tgUserId', async () => {
    const { sendMessage, bot } = makeBot();
    await handleEntry(
      { id: '1-0', payload: undefined, tgUserId: '1' },
      { redis: {} as never, bot: bot as unknown as Bot, log, consumerName: 'c1' },
    );
    await handleEntry(
      { id: '2-0', payload: '{}', tgUserId: undefined },
      { redis: {} as never, bot: bot as unknown as Bot, log, consumerName: 'c1' },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips entries with invalid JSON', async () => {
    const { sendMessage, bot } = makeBot();
    await handleEntry(
      { id: '1-0', payload: 'not json', tgUserId: '1' },
      { redis: {} as never, bot: bot as unknown as Bot, log, consumerName: 'c1' },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips entries with schema-invalid payload', async () => {
    const { sendMessage, bot } = makeBot();
    await handleEntry(
      {
        id: '1-0',
        payload: JSON.stringify({ ...SAMPLE_EVENT, coin: '' }),
        tgUserId: '1',
      },
      { redis: {} as never, bot: bot as unknown as Bot, log, consumerName: 'c1' },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('swallows telegram send errors so the loop can ack', async () => {
    const sendMessage = vi.fn(() => Promise.reject(new Error('network')));
    const bot = { api: { sendMessage } };
    await expect(
      handleEntry(
        { id: '1-0', payload: JSON.stringify(SAMPLE_EVENT), tgUserId: '1' },
        { redis: {} as never, bot: bot as unknown as Bot, log, consumerName: 'c1' },
      ),
    ).resolves.toBeUndefined();
  });

  it('skips delivery when prefsResolver reports the user is muted', async () => {
    const { sendMessage, bot } = makeBot();
    const prefsResolver = {
      prefsByTgUserId: vi.fn(() => Promise.resolve({ muted: true })),
    };
    await handleEntry(
      { id: '1-0', payload: JSON.stringify(SAMPLE_EVENT), tgUserId: '99' },
      {
        redis: {} as never,
        bot: bot as unknown as Bot,
        log,
        consumerName: 'c1',
        prefsResolver,
      },
    );
    expect(prefsResolver.prefsByTgUserId).toHaveBeenCalledWith('99');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('applies compact prefs from resolver to the rendered text', async () => {
    const { sendMessage, bot } = makeBot();
    const prefsResolver = {
      prefsByTgUserId: vi.fn(() => Promise.resolve({ muted: false, compact: true })),
    };
    await handleEntry(
      { id: '1-0', payload: JSON.stringify(SAMPLE_EVENT), tgUserId: '99' },
      {
        redis: {} as never,
        bot: bot as unknown as Bot,
        log,
        consumerName: 'c1',
        prefsResolver,
      },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]?.[1]);
    // Compact format uses ' · ' separator instead of newlines.
    expect(text).toContain(' · ');
    expect(text).not.toMatch(/\n/);
  });

  it('falls back to defaults when prefsResolver throws', async () => {
    const { sendMessage, bot } = makeBot();
    const prefsResolver = {
      prefsByTgUserId: vi.fn(() => Promise.reject(new Error('db down'))),
    };
    await handleEntry(
      { id: '1-0', payload: JSON.stringify(SAMPLE_EVENT), tgUserId: '99' },
      {
        redis: {} as never,
        bot: bot as unknown as Bot,
        log,
        consumerName: 'c1',
        prefsResolver,
      },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
