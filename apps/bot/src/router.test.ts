import { describe, expect, it } from 'vitest';
import { parseCommand } from './router.js';

describe('parseCommand', () => {
  it('returns null for non-command text', () => {
    expect(parseCommand('hello there')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('parses /start with no payload', () => {
    expect(parseCommand('/start')).toStrictEqual({ kind: 'start', startParam: null });
  });

  it('parses /start with a deep-link payload', () => {
    expect(parseCommand('/start ref_alice')).toStrictEqual({
      kind: 'start',
      startParam: 'ref_alice',
    });
  });

  it('accepts the @botusername suffix', () => {
    expect(parseCommand('/help@whalepod_bot')).toStrictEqual({ kind: 'help' });
  });

  it('parses /follow with target', () => {
    expect(parseCommand('/follow 0xabc')).toStrictEqual({
      kind: 'follow',
      target: '0xabc',
      maxSizeUsd: null,
    });
  });

  it('marks /follow with no arg as unknown', () => {
    expect(parseCommand('/follow')).toStrictEqual({ kind: 'unknown', raw: '/follow' });
  });

  it('rejects /fee (no longer a user-facing command)', () => {
    expect(parseCommand('/fee 50')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/fee 0')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/fee 100')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/fee 101')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/fee abc')).toMatchObject({ kind: 'unknown' });
  });

  it('parses pause / resume / kill / unkill / wallet', () => {
    expect(parseCommand('/pause')?.kind).toBe('pause');
    expect(parseCommand('/resume')?.kind).toBe('resume');
    expect(parseCommand('/kill')?.kind).toBe('kill');
    expect(parseCommand('/unkill')?.kind).toBe('unkill');
    expect(parseCommand('/wallet')?.kind).toBe('wallet');
  });

  it('parses /share', () => {
    expect(parseCommand('/share')?.kind).toBe('share');
    expect(parseCommand('/SHARE')?.kind).toBe('share');
  });

  it('parses /close <coin>', () => {
    expect(parseCommand('/close ETH')).toStrictEqual({ kind: 'close', coin: 'ETH' });
    expect(parseCommand('/close btc')).toStrictEqual({ kind: 'close', coin: 'BTC' });
    expect(parseCommand('/close')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/close ETH BTC')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/close not-a-coin')).toMatchObject({ kind: 'unknown' });
  });

  it('parses /closeall', () => {
    expect(parseCommand('/closeall')).toStrictEqual({ kind: 'closeall' });
    expect(parseCommand('/CLOSEALL')).toStrictEqual({ kind: 'closeall' });
  });

  it('parses /pnl', () => {
    expect(parseCommand('/pnl')?.kind).toBe('pnl');
    expect(parseCommand('/PNL')?.kind).toBe('pnl');
  });

  it('parses /leaderboard and /lb', () => {
    expect(parseCommand('/leaderboard')?.kind).toBe('leaderboard');
    expect(parseCommand('/lb')?.kind).toBe('leaderboard');
  });

  it('parses /notify variants', () => {
    expect(parseCommand('/notify')).toStrictEqual({ kind: 'notify', action: 'show' });
    expect(parseCommand('/notify on')).toStrictEqual({ kind: 'notify', action: 'on' });
    expect(parseCommand('/notify off')).toStrictEqual({ kind: 'notify', action: 'off' });
    expect(parseCommand('/notify mute')).toStrictEqual({ kind: 'notify', action: 'off' });
    expect(parseCommand('/notify compact')).toStrictEqual({ kind: 'notify', action: 'compact' });
    expect(parseCommand('/notify full')).toStrictEqual({ kind: 'notify', action: 'full' });
    expect(parseCommand('/notify VERBOSE')).toStrictEqual({ kind: 'notify', action: 'full' });
    expect(parseCommand('/notify bogus')).toMatchObject({ kind: 'unknown' });
  });

  it('returns unknown for any other slash command', () => {
    expect(parseCommand('/lolwut')).toStrictEqual({ kind: 'unknown', raw: '/lolwut' });
  });

  it('is case-insensitive on the command name', () => {
    expect(parseCommand('/HELP')).toStrictEqual({ kind: 'help' });
  });

  it('parses /tp and /sl with whale + bps', () => {
    expect(parseCommand('/tp 0xabc 500')).toStrictEqual({
      kind: 'tp',
      target: '0xabc',
      offsetBps: 500,
    });
    expect(parseCommand('/sl 0xabc 200')).toStrictEqual({
      kind: 'sl',
      target: '0xabc',
      offsetBps: 200,
    });
  });

  it('parses /tp <whale> off as clear', () => {
    expect(parseCommand('/tp 0xabc off')).toStrictEqual({
      kind: 'tp',
      target: '0xabc',
      offsetBps: null,
    });
  });

  it('marks /tp with out-of-range bps as unknown', () => {
    expect(parseCommand('/tp 0xabc 0')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/tp 0xabc 10000')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/tp 0xabc 1.5')).toMatchObject({ kind: 'unknown' });
    expect(parseCommand('/tp 0xabc')).toMatchObject({ kind: 'unknown' });
  });

  it('parses /watch with and without a target', () => {
    expect(parseCommand('/watch')).toStrictEqual({ kind: 'watch', target: null });
    expect(parseCommand('/watch 0xabc')).toStrictEqual({ kind: 'watch', target: '0xabc' });
    expect(parseCommand('/watch HYPE-Maxi')).toStrictEqual({ kind: 'watch', target: 'HYPE-Maxi' });
    expect(parseCommand('/WATCH 0xabc')).toStrictEqual({ kind: 'watch', target: '0xabc' });
    expect(parseCommand('/watch 0xabc extra')).toMatchObject({ kind: 'unknown' });
  });

  it('parses /unwatch with and without a target', () => {
    expect(parseCommand('/unwatch')).toStrictEqual({ kind: 'unwatch', target: null });
    expect(parseCommand('/unwatch 0xabc')).toStrictEqual({ kind: 'unwatch', target: '0xabc' });
    expect(parseCommand('/unwatch a b')).toMatchObject({ kind: 'unknown' });
  });
});
