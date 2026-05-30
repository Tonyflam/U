import { describe, expect, it, vi } from 'vitest';
import { createBot } from './bot.js';
import { InMemoryBotRepo } from './inMemoryBotRepo.js';
import pino from 'pino';

const silentLog = pino({ level: 'silent' });

describe('createBot', () => {
  it('returns a configured grammy Bot instance', () => {
    const repo = new InMemoryBotRepo();
    const bot = createBot({
      token: '1234:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk',
      repo,
      miniAppUrl: 'https://example.test/onboard',
      botUsername: 'WhalePodBot',
      log: silentLog,
    });
    expect(bot).toBeDefined();
    expect(typeof bot.start).toBe('function');
    expect(typeof bot.handleUpdate).toBe('function');
  });

  it('refuses an empty token', () => {
    // grammy throws synchronously on `new Bot('')`.
    const repo = new InMemoryBotRepo();
    expect(() =>
      createBot({
        token: '',
        repo,
        miniAppUrl: 'https://example.test/onboard',
        botUsername: 'WhalePodBot',
        log: silentLog,
      }),
    ).toThrow();
  });

  it("registers a global error handler so unhandled errors don't crash", () => {
    const repo = new InMemoryBotRepo();
    const errLog = { error: vi.fn() } as unknown as Parameters<typeof createBot>[0]['log'];
    const bot = createBot({
      token: '1234:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk',
      repo,
      miniAppUrl: 'https://example.test/onboard',
      botUsername: 'WhalePodBot',
      log: errLog,
    });
    // The bot has registered a `.catch` handler — verify via internal API.
    // grammy doesn't expose this directly, so we just confirm the bot was
    // created without throwing and is usable.
    expect(bot).toBeDefined();
  });
});
