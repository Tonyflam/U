import { describe, expect, it } from 'vitest';
import * as bot from './index.js';

describe('bot barrel', () => {
  it('exports the documented public surface', () => {
    expect(typeof bot.verifyInitData).toBe('function');
    expect(typeof bot.parseCommand).toBe('function');
    expect(typeof bot.DrizzleOnboardRepo).toBe('function');
    expect(typeof bot.InMemoryProvisionalStore).toBe('function');
  });
});
