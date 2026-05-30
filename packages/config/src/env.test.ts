import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, commonEnv, parseEnv } from './env.js';

describe('parseEnv', () => {
  it('parses valid env', () => {
    const env = parseEnv(commonEnv, {
      source: { NODE_ENV: 'test', LOG_LEVEL: 'warn', SERVICE_NAME: 'bot' },
    });
    expect(env.NODE_ENV).toBe('test');
    expect(env.LOG_LEVEL).toBe('warn');
    expect(env.SERVICE_NAME).toBe('bot');
  });

  it('applies defaults when fields omitted', () => {
    const env = parseEnv(commonEnv, { source: { SERVICE_NAME: 'bot' } });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws EnvValidationError on missing required field', () => {
    expect(() => parseEnv(commonEnv, { source: {} })).toThrow(EnvValidationError);
  });

  it('throws on invalid enum value', () => {
    expect(() =>
      parseEnv(commonEnv, { source: { SERVICE_NAME: 'bot', LOG_LEVEL: 'verbose' } }),
    ).toThrow(EnvValidationError);
  });

  it('error message lists each failing path', () => {
    try {
      parseEnv(commonEnv.extend({ EXTRA: z.string().url() }), {
        source: { SERVICE_NAME: 'bot', EXTRA: 'not-a-url' },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as Error).message).toContain('EXTRA');
    }
  });

  it('ignores dotenv files when NODE_ENV=production', () => {
    const env = parseEnv(commonEnv, {
      source: { NODE_ENV: 'production', SERVICE_NAME: 'bot' },
      dotenvPaths: ['/nonexistent/.env'],
    });
    expect(env.NODE_ENV).toBe('production');
  });
});
