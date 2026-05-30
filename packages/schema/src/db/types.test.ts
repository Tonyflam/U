import { describe, expect, it } from 'vitest';
import { Address, Coin, FeeTenthsBp, Side } from './types.js';

describe('Address', () => {
  it('accepts valid address and lowercases', () => {
    const parsed = Address.parse('0xAaBbCcDdEeFf00112233445566778899AaBbCcDd');
    expect(parsed).toBe('0xaabbccddeeff00112233445566778899aabbccdd');
  });

  it('rejects too-short hex', () => {
    expect(() => Address.parse('0xabc')).toThrow();
  });

  it('rejects missing 0x prefix', () => {
    expect(() => Address.parse('aabbccddeeff00112233445566778899aabbccdd')).toThrow();
  });

  it('rejects non-hex chars', () => {
    expect(() => Address.parse('0xZZbbccddeeff00112233445566778899aabbccdd')).toThrow();
  });
});

describe('Coin', () => {
  it('accepts BTC', () => {
    expect(Coin.parse('BTC')).toBe('BTC');
  });

  it('rejects lowercase', () => {
    expect(() => Coin.parse('btc')).toThrow();
  });

  it('rejects empty', () => {
    expect(() => Coin.parse('')).toThrow();
  });
});

describe('Side', () => {
  it('accepts B and S', () => {
    expect(Side.parse('B')).toBe('B');
    expect(Side.parse('S')).toBe('S');
  });

  it('rejects other values', () => {
    expect(() => Side.parse('BUY')).toThrow();
  });
});

describe('FeeTenthsBp', () => {
  it('accepts 50 (= 5 bps)', () => {
    expect(FeeTenthsBp.parse(50)).toBe(50);
  });

  it('accepts the protocol cap of 100 (= 10 bps)', () => {
    expect(FeeTenthsBp.parse(100)).toBe(100);
  });

  it('rejects above cap', () => {
    expect(() => FeeTenthsBp.parse(101)).toThrow();
  });

  it('rejects negative', () => {
    expect(() => FeeTenthsBp.parse(-1)).toThrow();
  });

  it('rejects non-integer', () => {
    expect(() => FeeTenthsBp.parse(5.5)).toThrow();
  });
});
