import { describe, expect, it } from 'vitest';
import { generateAgentKey } from './agentKey.js';

describe('generateAgentKey', () => {
  it('produces a 32-byte private key and matching lowercase 0x address', () => {
    const k = generateAgentKey();
    expect(k.privateKey).toBeInstanceOf(Uint8Array);
    expect(k.privateKey.length).toBe(32);
    expect(k.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('produces unique keys per call', () => {
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(a.address).not.toBe(b.address);
    expect(Buffer.from(a.privateKey).equals(Buffer.from(b.privateKey))).toBe(false);
  });
});
