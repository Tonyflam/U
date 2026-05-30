/**
 * Pure HTML renderer for the WhalePod landing page.
 *
 * Why a renderer rather than a static .html file:
 *  - The protocol fee cap (10 bps) and default fee (5 bps) come from
 *    `@whalepod/sdk` so we can NEVER ship a page that quotes wrong numbers.
 *    A snapshot test guards the rendered output.
 *  - The TG launch URL is environment-controlled and trivially escaped here.
 *  - We still emit a flat .html via `buildLandingHtml(env)` — no React tree,
 *    no client JS, no analytics.
 */
import { BUILDER_FEE_DEFAULT_TENTHS_BP, BUILDER_FEE_PERP_CAP_TENTHS_BP } from '@whalepod/sdk';

export interface LandingEnv {
  /**
   * Full t.me URL to the bot, e.g. `https://t.me/WhalePodBot`. Validated by
   * the caller; we still HTML-escape it before interpolation.
   */
  readonly botUrl: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => HTML_ESCAPES[c] ?? c);
}

function fmtBps(tenthsBp: number): string {
  return `${(tenthsBp / 10).toFixed(1)} bps`;
}

const CSS = `:root{--bg:#0b0d10;--fg:#e6edf3;--accent:#3bd5b5;--muted:#8b949e;--card:#161b22}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 24px}
h1{font-size:40px;margin:0 0 8px;letter-spacing:-0.02em}
h1 span{color:var(--accent)}
.lede{color:var(--muted);font-size:18px;margin:0 0 32px}
.cta{display:inline-block;background:var(--accent);color:#04201a;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:8px}
.cta:focus{outline:2px solid #fff;outline-offset:3px}
section{background:var(--card);border-radius:12px;padding:20px 24px;margin:24px 0}
h2{font-size:18px;margin:0 0 12px}
ul{margin:0;padding-left:18px}
li{margin:6px 0}
.fee{font-variant-numeric:tabular-nums}
.notice{font-size:13px;color:var(--muted);margin-top:32px;border-top:1px solid #21262d;padding-top:16px}
.notice a{color:var(--muted)}`;

export function buildLandingHtml(env: LandingEnv): string {
  const botUrl = escapeHtml(env.botUrl);
  const defaultFee = fmtBps(BUILDER_FEE_DEFAULT_TENTHS_BP);
  const capFee = fmtBps(BUILDER_FEE_PERP_CAP_TENTHS_BP);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhalePod — copy-trade Hyperliquid in Telegram</title>
<meta name="description" content="Mirror Hyperliquid perp whales directly from Telegram. Non-custodial. Builder fee capped at ${capFee}.">
<meta name="robots" content="index, follow">
<meta property="og:title" content="WhalePod">
<meta property="og:description" content="Copy-trade Hyperliquid perps from Telegram. Non-custodial. Fee capped at ${capFee}.">
<meta property="og:type" content="website">
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Whale<span>Pod</span></h1>
<p class="lede">Copy-trade Hyperliquid perps from Telegram. Your keys, your agent, your kill switch.</p>
<a class="cta" href="${botUrl}" rel="noopener">Launch in Telegram</a>

<section>
<h2>How it works</h2>
<ul>
<li>Connect your Hyperliquid wallet in the WhalePod Telegram app.</li>
<li>WhalePod generates an <strong>agent key</strong> on Hyperliquid for execution. The agent <strong>cannot withdraw</strong>; only place and cancel orders.</li>
<li>Pick whales to mirror. Set your size cap, take-profit, stop-loss, and kill switch.</li>
</ul>
</section>

<section>
<h2>Fees</h2>
<ul>
<li class="fee">Default builder fee: <strong>${defaultFee}</strong> per fill.</li>
<li class="fee">Protocol cap: <strong>${capFee}</strong> per fill (hard ceiling enforced by Hyperliquid).</li>
<li>No deposit, no subscription, no custody — we never hold your funds.</li>
</ul>
</section>

<section>
<h2>What WhalePod will never do</h2>
<ul>
<li>Move funds off Hyperliquid. Agent keys are scoped to trading.</li>
<li>Change your fee above the on-chain approval you signed.</li>
<li>Sell your data or run third-party analytics on this page.</li>
</ul>
</section>

<p class="notice">Trading derivatives carries risk of loss. WhalePod is a tool, not investment advice. Open source: <a href="https://github.com/whalepod" rel="noopener">github.com/whalepod</a>.</p>
</main>
</body>
</html>
`;
}
