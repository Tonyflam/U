import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { createAdminBot, parseOperatorIds } from './start.js';
import { InMemoryAdminRepo } from './inMemoryAdminRepo.js';

const silentLog = pino({ level: 'silent' });

describe('parseOperatorIds', () => {
  it('parses a single id', () => {
    const set = parseOperatorIds('42');
    expect(set.has(42n)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('parses a comma list with whitespace', () => {
    const set = parseOperatorIds(' 1, 2 ,3 ');
    expect([...set].sort()).toEqual([1n, 2n, 3n]);
  });

  it('rejects non-numeric ids', () => {
    expect(() => parseOperatorIds('1,abc,3')).toThrow(/Invalid operator/u);
  });

  it('rejects zero or negative', () => {
    expect(() => parseOperatorIds('0')).toThrow(/positive/u);
  });

  it('rejects empty list', () => {
    expect(() => parseOperatorIds(' , ')).toThrow(/at least one/u);
  });
});

describe('createAdminBot', () => {
  it('returns a configured grammy Bot', () => {
    const bot = createAdminBot({
      token: '1234567890:AA' + 'x'.repeat(40),
      operators: new Set([99n]),
      repo: new InMemoryAdminRepo(),
      log: silentLog,
    });
    expect(typeof bot.handleUpdate).toBe('function');
  });

  it('refuses empty token', () => {
    expect(() =>
      createAdminBot({
        token: '',
        operators: new Set([1n]),
        repo: new InMemoryAdminRepo(),
        log: silentLog,
      }),
    ).toThrow();
  });
});
