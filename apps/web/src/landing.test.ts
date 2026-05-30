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

  it('embeds the bot URL in the CTA', () => {
    const html = buildLandingHtml(env);
    expect(html).toMatch(/<a class="cta" href="https:\/\/t\.me\/WhalePodBot"/);
  });

  it('escapes a malicious bot URL', () => {
    const html = buildLandingHtml({ botUrl: '"><script>alert(1)</script>' });
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('quotes the protocol cap fee from the SDK constant (not a literal)', () => {
    const html = buildLandingHtml(env);
    const expected = `${(BUILDER_FEE_PERP_CAP_TENTHS_BP / 10).toFixed(1)} bps`;
    // capFee appears in the description meta and in the fees section.
    expect(html.match(new RegExp(expected.replace('.', '\\.'), 'gu')) ?? []).toHaveLength(3);
  });

  it('quotes the default fee from the SDK constant', () => {
    const html = buildLandingHtml(env);
    const expected = `${(BUILDER_FEE_DEFAULT_TENTHS_BP / 10).toFixed(1)} bps`;
    expect(html).toContain(expected);
  });

  it('includes the non-custodial / no-withdraw assurances', () => {
    const html = buildLandingHtml(env);
    expect(html).toMatch(/cannot withdraw/);
    expect(html).toMatch(/we never hold your funds/i);
  });

  it('renders deterministic snapshot of the document head + CTA', () => {
    const html = buildLandingHtml(env);
    const head = html.slice(0, html.indexOf('<style>'));
    expect(head).toMatchInlineSnapshot(`
      "<!doctype html>
      <html lang="en">
      <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>WhalePod — copy-trade Hyperliquid in Telegram</title>
      <meta name="description" content="Mirror Hyperliquid perp whales directly from Telegram. Non-custodial. Builder fee capped at 10.0 bps.">
      <meta name="robots" content="index, follow">
      <meta property="og:title" content="WhalePod">
      <meta property="og:description" content="Copy-trade Hyperliquid perps from Telegram. Non-custodial. Fee capped at 10.0 bps.">
      <meta property="og:type" content="website">
      "
    `);
  });

  it('contains no <script> tags and no inline event handlers', () => {
    const html = buildLandingHtml(env);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
