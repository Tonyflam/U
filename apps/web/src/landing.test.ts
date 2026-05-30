import { describe, expect, it } from 'vitest';
import { BUILDER_FEE_DEFAULT_TENTHS_BP, BUILDER_FEE_PERP_CAP_TENTHS_BP } from '@whalepod/sdk';
import { buildLandingHtml, escapeHtml } from './landing.js';

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<script>alert("x&y")</script>'`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;',
    );
  });

  it('is a no-op for safe ASCII', () => {
    expect(escapeHtml('https://t.me/WhalePodBot')).toBe('https://t.me/WhalePodBot');
  });
});

describe('buildLandingHtml', () => {
  const env = { botUrl: 'https://t.me/WhalePodBot' };

  it('embeds the bot URL in a CTA', () => {
    const html = buildLandingHtml(env);
    expect(html).toMatch(/href="https:\/\/t\.me\/WhalePodBot"/);
  });

  it('escapes a malicious bot URL', () => {
    const html = buildLandingHtml({ botUrl: '"><script>alert(1)</script>' });
    expect(html).not.toMatch(/"><script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('quotes the protocol cap fee from the SDK constant (not a literal)', () => {
    const html = buildLandingHtml(env);
    const expected = `${(BUILDER_FEE_PERP_CAP_TENTHS_BP / 10).toFixed(1)} bps`;
    expect(html).toContain(expected);
  });

  it('quotes the default fee from the SDK constant', () => {
    const html = buildLandingHtml(env);
    const expected = `${(BUILDER_FEE_DEFAULT_TENTHS_BP / 10).toFixed(1)} bps`;
    expect(html).toContain(expected);
  });

  it('includes the non-custodial / no-withdraw assurances', () => {
    const html = buildLandingHtml(env);
    expect(html).toMatch(/Withdraw is impossible/i);
    expect(html).toMatch(/never has a balance to drain/i);
  });

  it('contains no inline event handlers', () => {
    const html = buildLandingHtml(env);
    expect(html).not.toMatch(/\son(click|load|error|mouseover|focus|submit)\s*=/i);
  });
});
