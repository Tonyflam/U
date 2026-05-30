import { describe, expect, it } from 'vitest';
import { zeroize } from './kms.js';

describe('zeroize', () => {
  it('overwrites buffer contents with zeros', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0]);
  });

  it('handles undefined safely', () => {
    expect(() => {
      zeroize(undefined);
    }).not.toThrow();
  });

  it('handles null safely', () => {
    expect(() => {
      zeroize(null);
    }).not.toThrow();
  });

  it('handles empty buffer', () => {
    const buf = new Uint8Array(0);
    expect(() => {
      zeroize(buf);
    }).not.toThrow();
    expect(buf.length).toBe(0);
  });
});
