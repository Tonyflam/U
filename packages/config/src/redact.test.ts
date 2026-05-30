import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './redact.js';

describe('REDACT_PATHS', () => {
  it('covers core secret field names', () => {
    const joined = REDACT_PATHS.join('\n');
    for (const must of [
      'privateKey',
      'agentKey',
      'mnemonic',
      'signature',
      'authorization',
      'botToken',
      'initData',
      'Plaintext',
      'CiphertextBlob',
    ]) {
      expect(joined).toContain(must);
    }
  });

  it('is non-empty and unique', () => {
    expect(REDACT_PATHS.length).toBeGreaterThan(10);
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
  });
});
