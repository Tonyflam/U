# WhalePod — Phase 1: Strategy, Roadmap & Pre-Build Playbook

> **Status:** Phase 0 closed. Name locked: **WhalePod**. Domain: **whalepod.trade**.
> Wedge: copy-trading on Hyperliquid via Telegram, PnL share-cards as distribution.
> Confidence: 55–70% for $5K month-1.

---

## 1. Positioning Statement

> **WhalePod is the Telegram client for Hyperliquid that mirrors top traders into your account, sub-second, non-custodial.**

Use this sentence verbatim across: TG bot `/start`, X bio, GitHub repo description, landing `<meta description>`, OG card sub-copy. **Do not iterate on it without a numeric reason** (conversion drop, foundation feedback, lawyer redline).

### Supporting one-liners (situational)

| Surface                   | Copy                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| TG `/start` first message | _"Mirror Hyperliquid whales from Telegram. We can't touch your funds — only place trades."_ |
| X bio                     | _"Mirror Hyperliquid whales from Telegram. Non-custodial. whalepod.trade"_                  |
| Landing H1                | _"Mirror Hyperliquid whales."_                                                              |
| Landing H2                | _"Pick a wallet. Approve once. Every fill, mirrored to yours in under a second."_           |
| OG card sub               | _"mirror hyperliquid whales"_                                                               |

**Voice rules** (binding on all written output):

1. Lowercase brand: `whalepod`, never `WhalePod`, except in formal/legal documents.
2. No emoji, ever, in product copy. Allowed in TG admin commands for system status only (✅ ⚠️ ❌).
3. No exclamation marks. No "🚀". No "WAGMI". No "fam". No "anon".
4. State features as facts, not promises. "Mirrors fills in under one second" not "lightning-fast mirroring!".
5. Numbers over adjectives. "Up to 0.05% fee" not "low fees".
6. Never use: _moon, gem, alpha drop, degen tools, financial freedom, life-changing, ape, rugproof, secure (use "non-custodial" instead — provable claim)._

---

## 2. ICP — Ideal Customer Profile

### Who we win

**Profile: "The Hyperliquid Mid-Tier Mirror"**

| Attribute                 | Value                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account equity on HL      | $500 – $25,000                                                                                                                                                                                                               |
| Trading frequency         | 3–30 trades/week                                                                                                                                                                                                             |
| Avg leverage              | 5x – 15x perps                                                                                                                                                                                                               |
| Daily notional volume     | $5K – $80K                                                                                                                                                                                                                   |
| Where they live online    | TG groups (HL alpha, signal, Hyperliquid trader chats), X crypto FinTwit, Hyperliquid Discord #trading                                                                                                                       |
| Devices                   | Phone primary, desktop secondary                                                                                                                                                                                             |
| Existing tools            | HL web frontend, maybe Hyperdash for tracking, maybe a generic TG bot, **no current good copy-trade option**                                                                                                                 |
| Pain points               | (a) Misses trades while asleep / at work. (b) Can't size positions like the whales they admire. (c) Tracks 10 whales manually in Hyperdash, forgets to enter. (d) Watches a whale make 40% on a flip they missed by 3 hours. |
| Spends per month on tools | $0–$50 (most spend nothing)                                                                                                                                                                                                  |
| Capital sensitivity       | High. Will not pay a subscription. Will pay a fee skim because it's invisible.                                                                                                                                               |

### Who we do NOT win (and stop trying)

- **<$500 equity:** revenue-per-user too low to justify support load.
- **>$100K equity:** they hire bots/quants, don't use TG.
- **Pure spot traders:** v1 is perp-only.
- **US institutional:** wrong wrapper, wrong distribution, wrong product.

### Objections, in their voice

| They say                                     | We say                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Why would I give a bot my keys?"            | You don't. You approve a session key that can only place trades. It cannot withdraw. We show you the on-chain proof in `/about`. Revoke any time with `/revoke`.                         |
| "How do I know you're not front-running me?" | All orders carry your wallet, signed by your agent key. We have no way to insert our own orders ahead of yours. The order routing is open-source.                                        |
| "Copy-trading always ends in pain. Why now?" | Because you pick the whale, set max position size, and we hard-stop new mirrors when your equity drops below your floor. You ride; you also control the brakes.                          |
| "What's the fee?"                            | 0.05% per fill. Same as the spread you eat on most CEXes. Capped at 0.1% by the Hyperliquid protocol — we can't go higher even if we wanted to.                                          |
| "Why Telegram and not an app?"               | Because you already have Telegram open. No app store wait. No download. Three seconds from `/start` to first trade.                                                                      |
| "What if you go down?"                       | Your funds are on Hyperliquid, not us. If we vanish tomorrow, you `/revoke` (or the foundation does it for you on-chain) and trade normally on app.hyperliquid.xyz with no interruption. |

---

## 3. Habit Loop

We are not selling features. We are installing a daily ritual.

```
TRIGGER          →  ACTION          →  REWARD         →  INVESTMENT
─────────────────────────────────────────────────────────────────────
TG notification  →  Tap the card    →  See PnL +%     →  Add a whale /
"Whale X opened     /positions or      and share it      raise max size /
LONG ETH 10x"       /skip                                refer a friend
```

| Loop component | Our implementation                                                                                                                                                     | Cadence                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Trigger**    | TG push notification: "0xWHALE opened LONG ETH 10x — mirrored to your account at $3,412. /positions"                                                                   | Every mirrored fill, every whale signal-event |
| **Action**     | One tap in TG: `/positions`, `/close`, `/share`, `/skip`                                                                                                               | <3 seconds                                    |
| **Reward**     | Variable schedule (the whale wins sometimes, loses sometimes — variable-ratio reinforcement is the most habit-forming). PnL card image with their personal % displayed | Per-fill                                      |
| **Investment** | User tunes their settings — adds more whales, raises max size, brings in friends via share-card → sunk cost increases stickiness                                       | Daily–weekly                                  |

**The TG notification is the keystone.** Every product decision is judged against: _does this strengthen the trigger?_ Adding spot in v1 weakens the trigger (more notification types = notification blindness). Adding DCA in v1 weakens the trigger (set-and-forget notifications get muted). **Both stay deferred.**

---

## 4. Viral Loop — Design & K-Factor Math

### The artifact

The **PnL share card** (template A5). Generated automatically after any closing fill that resulted in **>+10% or <−10% ROI on that position**. Auto-saved to user's TG chat history. **One-tap share button:** `📤 Share` → forwards card image with caption to any TG chat.

### What's baked in vs runtime

| Element                                    | Source                                  | Purpose                                                          |
| ------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------- |
| Brand logo + wordmark                      | Static (in template)                    | Recognition                                                      |
| PnL %                                      | Runtime, per fill                       | The hook                                                         |
| Ticker + leverage                          | Runtime, per fill                       | Context                                                          |
| Mirrored whale alias                       | Runtime, per fill                       | Social proof                                                     |
| **Referral link** `whalepod.trade/r/{REF}` | Runtime, per user                       | The conversion path — every card sent = 1 user × N viewers × CTR |
| Watermark "via whalepod"                   | Static-ish, runtime-styled bottom-right | Brand attribution even on screenshots                            |

### K-factor math

Let:

- `S` = fraction of qualifying PnL events that get shared by the user.
- `V` = average TG chat audience of the share (people who see the card).
- `C` = click-through rate (viewers → /start the bot).
- `O` = onboarding completion rate (/start → first trade).

**K-factor = S × V × C × O**

| Scenario    | S   | V   | C   | O   | K         |
| ----------- | --- | --- | --- | --- | --------- |
| Pessimistic | 5%  | 30  | 4%  | 30% | **0.018** |
| Base        | 10% | 80  | 6%  | 50% | **0.24**  |
| Optimistic  | 20% | 200 | 10% | 65% | **2.60**  |
| Stretch     | 30% | 400 | 12% | 70% | **10.08** |

**Read this carefully:**

- **Base case K = 0.24 is sub-viral.** That means each user brings 0.24 new users. Compounding is weak — it amplifies cold-start traffic but does not replace it.
- **Optimistic K = 2.60 is exponentially viral.** Each user brings 2.6 new users. This is the BONKbot regime.
- **The path from base to optimistic runs through three levers:** (1) PnL-card design quality (drives S and C), (2) seeding mirror campaigns on the 5 most-followed HL whales so winning trades cluster (drives S), (3) onboarding friction reduction (drives O — the single largest multiplier).

**Implication for build:** the PnL-card renderer (U12) is more strategically important than any individual trading feature. Treat U12 as a flagship unit, not a finishing detail.

### Two secondary viral artifacts

1. **Copy-trade subscription card** (template A6) — auto-generated when user adds a whale. Tap `📤 Share` to post "now mirroring 0xWHALE — 142% 30d ROI". Lower conversion than PnL card but generates supply-side: more users → more `/track` activity → more leaderboard data.
2. **Leaderboard rank card** (template A7) — auto-generated weekly for top-100 users by ROI. Tap-to-share. Triggers vanity-driven sharing.

### Distribution math, end-to-end

Hyperliquid daily perp volume = **$6–8B** (your Q-9 verification).

Target: $5K month-1 fees at 5 bps = **$10M of mirrored notional needed in month 1** = **~$333K/day routed volume** = **6 active users at $50K/day each** (or 22 at $15K/day).

We don't need K > 1. We need ~22 retained mid-tier users in 30 days. **K = 0.24 + 30 organic seed signups from HL Discord #builders post + 1 awesome-list PR ≈ ~40–80 signups, of which ~25% retain as daily-active mirrors ≈ 10–20 retained.** Inside the target band.

---

## 5. Roadmap — Milestone-Gated

No dates. Each milestone has a **Definition of Done (DoD)** and an **exit criterion** that must be visibly true before proceeding.

### M0 — Pre-Build Setup

**DoD:** All accounts, domains, repos, and free-tier services exist. Telegram bot registered. Brand assets generated. Legal scaffolding drafted.
**Exit:** Section 7 (Playbook) is 100% green.

### M1 — SDK Wrapper & Order Path

**Units:** U1–U5
**DoD:** Can place a perp market order on testnet via a thin TS wrapper around `@nktkas/hyperliquid`, with builder fee `f` attached, WebSocket fills streaming back. All paths property-tested.
**Exit:** Testnet order placed, fill received via WS, builder fee parameter verifiable in returned response. 100% test coverage on order construction.

### M2 — Vault & Mini-App Approval Flow

**Units:** U6–U7
**DoD:** Main wallet can approve agent + builder fee via mini-app in <60 seconds, end-to-end. Agent key encrypted at rest. Withdrawal-from-agent-key test FAILS as expected (proves protocol-side isolation).
**Exit:** Three test users complete onboarding in <60s median. Security checklist for U6/U7 100% green.

### M3 — TG Bot Core

**Units:** U8–U9
**DoD:** `/start`, `/track <addr>`, `/copy`, `/uncopy`, `/positions`, `/close`, `/settings`, `/revoke`, `/about` all work. Per-user rate-limit enforced. Mirror engine fills <1s after whale fill.
**Exit:** Manual end-to-end test on testnet: track a whale, see fills mirror, close, revoke. All under 60 minutes start-to-finish for a fresh user.

### M4 — Safety Rails

**Units:** U10–U11
**DoD:** TP/SL engine works. Max-size, max-leverage, equity-floor guardrails enforced server-side. Notification engine pages user on: copied-fill, liquidation-warning, equity-floor-breach, whale-stops-trading.
**Exit:** Adversarial test: try to bypass max-size via concurrent /copy requests — fails. Equity-floor breach correctly halts new mirrors.

### M5 — Viral Engine

**Units:** U12–U13
**DoD:** PnL card auto-generates within 2s of qualifying close. Copy-trade card and leaderboard card render correctly. Referral code embedded and click-tracked end-to-end. Leaderboard updates hourly.
**Exit:** 5 test users each generate a PnL card, share to a test TG group, click the ref link, complete /start — full loop closed and tracked in admin.

### M6 — Landing + Admin + Dress Rehearsal

**Units:** U14–U16
**DoD:** whalepod.trade live. Admin dashboard shows DAU, fills, fee revenue, error rate. Testnet dress rehearsal: 10 simulated users for 48h continuous, no critical errors.
**Exit:** Zero P0/P1 errors in 48h testnet run. Landing page Lighthouse perf ≥90, accessibility ≥95.

### M7 — Mainnet Closed Beta

**Unit:** U17
**DoD:** ≤25 invited mainnet users, real funds, 7-day window. Daily monitoring.
**Exit:** ≥80% of beta users complete first mirror trade. <2% fill latency over 2s. Zero fund-loss incidents traceable to WhalePod logic. Net Promoter ≥7 from beta survey.

### M8 — Security Sign-Off

**Unit:** U18
**DoD:** Pre-launch security checklist (Phase 2) 100% ticked. External eyes asked to review (HL Discord #builders informal pass, no paid audit).
**Exit:** No P0/P1 findings open. `SECURITY.md` published. `security.txt` deployed.

### M9 — Public Launch

**Unit:** U19
**DoD:** Single technical thread posted to HL Discord #builders. PRs to HL `awesome-hyperliquid` repo and ecosystem pages. Pinned tweet live. **No paid promotion. No DMs. No KOLs.**
**Exit:** Public. Telemetry green. On-call rotation (you, solo, 24/7 for week 1) armed.

### M10 — Month-1 Review

**Unit:** U20
**DoD:** Daily/weekly/monthly templates running. Cohort analysis live.
**Exit (success):** ≥$5K in builder-code fees accrued, ≥25 retained DAU, K ≥ 0.15, zero security incidents.
**Exit (kill):** see §9 kill criteria.

---

## 6. Risk Register

P = probability (0–5), I = impact (0–5), Score = P × I. Sorted by score desc.

| #   | Risk                                                                          | Category     | P   | I   | Score | Mitigation                                                                                                                                                                                        | Trigger                                                    |
| --- | ----------------------------------------------------------------------------- | ------------ | --- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Agent-key compromise (server breach, env leak)                                | Security     | 2   | 5   | 10    | KMS-encrypted at rest, in-memory zeroization, no keys in logs, secret-scanning pre-commit, hardware 2FA on every infra account.                                                                   | Any anomalous order placement, KMS alert, npm-audit alarm. |
| 2   | Copy-trade losses → user blames us → reputational/legal                       | Market/Legal | 4   | 4   | 16    | Plain-language disclaimers at /start, /copy, /track. Equity-floor guardrail server-side. Max-size caps. ToS clear. Geofence US until lawyer review. Position as "execution tool", never "advice". | First refund demand or public complaint.                   |
| 3   | HypurrBot or new entrant ships polished copy-trading first                    | Market       | 3   | 4   | 12    | Speed of execution. Wedge-narrow. Foundation-aligned awesome-list PR. Build the share-card loop first.                                                                                            | Competitor announcement during build.                      |
| 4   | Telegram bans the bot (ToS — financial promotion / gambling-adjacent framing) | Regulatory   | 2   | 5   | 10    | Strict copy review against TG terms. No "earn"/"yield"/"win"/"profit" language. Mirror = tool framing. Backup TG account ready.                                                                   | TG warning email.                                          |
| 5   | OFAC / sanctions exposure                                                     | Regulatory   | 2   | 5   | 10    | TG-update layer country-code geofence. ToS sanctions clause. Lawyer review pre-launch. No KYC by design — we are non-custodial frontend.                                                          | Regulator letter, exchange request, news event.            |
| 6   | Mass liquidation event (BTC -20% candle) → user fund loss + support flood     | Market       | 3   | 4   | 12    | Equity-floor halt. Liquidation-warning notification. Pre-written incident comms. Killswitch can globally pause new mirrors.                                                                       | Funding rate flips extreme or vol > 2σ.                    |
| 7   | Builder code fee cap reduced by HL protocol                                   | Protocol     | 1   | 4   | 4     | Diversify revenue (eventual premium tier — out of scope v1). Stay aligned with foundation.                                                                                                        | HL governance/announcement.                                |
| 8   | `@nktkas/hyperliquid` SDK breaking change or abandonment                      | Supply-chain | 2   | 3   | 6     | Pinned lockfile. Read source. Forkable. Python SDK as reference oracle. Direct API fallback documented.                                                                                           | Library deprecation notice.                                |
| 9   | Hyperliquid downtime during volatile market                                   | Protocol     | 2   | 4   | 8     | Killswitch + auto-pause on WS disconnect >30s. User-facing status banner. Incident comms template.                                                                                                | HL status page red.                                        |
| 10  | Whale changes wallet → mirror users continue mirroring dead address           | Product      | 4   | 3   | 12    | Auto-detect: if whale wallet inactive >48h, push notification + offer to swap.                                                                                                                    | WS shows no fills for 48h on watched address.              |
| 11  | Onboarding completion <30%                                                    | Product      | 3   | 5   | 15    | Mini-app session-key UX heavy iteration in M2. Three-screen max. Telemetry per step.                                                                                                              | Phase 3 metric.                                            |
| 12  | Founder bus-factor — you get hit by a bus                                     | Key-person   | 1   | 5   | 5     | `BUS_FACTOR.md` private repo, KMS escrow, killswitch documented, revenue-wallet keys in encrypted backup with trusted recovery party.                                                             | N/A.                                                       |
| 13  | NPM supply-chain attack via transitive dep                                    | Supply-chain | 2   | 4   | 8     | `--ignore-scripts` in CI, `npm audit signatures`, Dependabot, pinned base image by digest, CodeQL.                                                                                                | CI alarm.                                                  |
| 14  | TG bot token leaked                                                           | Security     | 1   | 5   | 5     | Token in KMS, never in env files in prod, rotation runbook.                                                                                                                                       | Webhook origin anomaly.                                    |
| 15  | Foundation explicitly does not amplify (silent)                               | Market       | 3   | 3   | 9     | Distribution does not depend on amplification — the share-card loop is the primary engine. Foundation amplification is upside.                                                                    | Phase 4 metric.                                            |

**Scoring discipline:** anything ≥12 is a top priority and gets explicit countermeasures in Phase 2. Risks 2, 11, 6, 10, 3 are the top five.

---

## 7. Pre-Build Playbook (Milestone M0)

Execute in order. Check the box. Do not skip.

### 7.1 Domains & DNS

- [ ] Buy `whalepod.trade` at Cloudflare Registrar (preferred — at-cost pricing, free WHOIS privacy). Fallback: Namecheap. **Budget cap: $30.**
- [ ] Add to Cloudflare DNS (free tier).
- [ ] Buy defensive set if <$15/each total: `whalepod.app`, `whalepod.xyz`, `whalepodbot.com`. Skip if over budget.
- [ ] Enable Cloudflare full SSL, HSTS, WAF managed ruleset (free tier).
- [ ] DNS records (placeholder targets, fill at U14):
  - `A` apex → Vercel
  - `CNAME` www → apex
  - `CNAME` api → Fly.io app
  - `CNAME` app → Vercel (mini-app)
  - `MX` → Cloudflare Email Routing
- [ ] Cloudflare Email Routing: catch-all → forwards to your personal mailbox. Specific routes: `hello@`, `security@`, `legal@`, `support@`.

### 7.2 Brand identity creation

- [ ] Generate A1–A7 via Nano Banana Pro using prompts in `docs/brand/image-prompts.md`.
- [ ] Save assets to a private repo `whalepod/brand` (or `docs/brand/assets/` if monorepo).
- [ ] Verify each template (A5–A7) has NO baked-in data text. If any template renders `{REF}` or numbers, regenerate.

### 7.3 X / Twitter

- [ ] Register account: try `@whalepod` → fallback `@whalepodtrade` → fallback `@whalepod_app`.
- [ ] Enable hardware-key 2FA only. Disable SMS recovery. **Mandatory.**
- [ ] Profile pic: A1 (square avatar).
- [ ] Header: blank `#0A0A0B` rectangle 1500×500 — DO NOT generate elaborate header art. Negative space is the brand.
- [ ] Bio (140 char limit):
  > `mirror hyperliquid whales from telegram. non-custodial. whalepod.trade`
- [ ] Pinned tweet — **draft only, do not post until M9 (public launch).** Save in `docs/launch/pinned-tweet.md`.
- [ ] First 10 posts — drafted in `docs/launch/first-10-tweets.md`. **Do not post until M9.**

### 7.4 Telegram setup

- [ ] Reserve bot username via `@BotFather` → `/newbot` → try `@whalepod_bot` → fallback `@whalepodapp_bot` → fallback `@whalepod_hl_bot`.
- [ ] Save `BOT_TOKEN` directly into KMS / secret manager. **Never paste into a chat, email, or env file.**
- [ ] `/setdescription` → "Mirror Hyperliquid whales. Non-custodial. whalepod.trade"
- [ ] `/setabouttext` → same.
- [ ] `/setuserpic` → A1.
- [ ] `/setcommands` → list of `/start /track /copy /uncopy /positions /close /settings /revoke /about /help`.
- [ ] `/setdomain` → `whalepod.trade` (required for Mini-App).
- [ ] `/setjoingroups` → Disable (bot is DM-only).
- [ ] `/setprivacy` → Enabled (bot ignores non-command messages in groups).
- [ ] Create public channel `@whalepod_news` for status announcements only (not marketing).
- [ ] Create public group `@whalepod_chat` — closed until M9, no announcement.

### 7.5 GitHub organization

- [ ] Create org `github.com/whalepod`.
- [ ] Repo structure (monorepo recommended for solo founder):
  ```
  whalepod/
    apps/
      bot/         # Telegram bot
      miniapp/     # Next.js wallet approval mini-app
      web/         # Landing page
      admin/       # Internal dashboard
    packages/
      sdk/         # HL SDK wrapper
      schema/      # Zod schemas + DB types
      ui/          # Shared React components
    docs/
    .github/
  ```
- [ ] License choice: **AGPL-3.0** for the bot (`apps/bot`) and order-routing logic. **Apache-2.0** for SDK wrapper (`packages/sdk`). **MIT** for landing page.
  - _Reasoning:_ AGPL prevents a competitor from running a closed-source fork as a service. Apache for SDK so the ecosystem can adopt. MIT for landing because it's trivial.
- [ ] `README.md` — minimal stub. Links to whalepod.trade. Do not over-share architecture details pre-launch.
- [ ] `SECURITY.md` — see template in §7.10.
- [ ] `/.well-known/security.txt` — added in U14 alongside landing.
- [ ] `CONTRIBUTING.md` — minimal: "Issues welcome. PRs accepted after discussion. Sign commits with GPG."
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1, paste verbatim.
- [ ] Enable: Dependabot (security + version updates weekly), CodeQL (default queries + extended security), secret scanning + push protection, branch protection on `main` (require 1 approval — yes, even solo; protects against accidental force-push), require signed commits.
- [ ] `.github/workflows/ci.yml` — lint, typecheck, test on every PR. Built in U1.

### 7.6 Legal — DRAFT only (lawyer review gates M9)

- [ ] `docs/legal/terms-of-service.md` — draft. Sections must include:
  1. Service is a non-custodial frontend.
  2. WhalePod never holds user funds.
  3. Agent keys cannot withdraw — protocol-enforced.
  4. Copy-trading carries total-loss risk.
  5. Past performance ≠ future results.
  6. Geofence: not available in US, OFAC-sanctioned jurisdictions, [list].
  7. No fiduciary duty.
  8. Fee: up to 0.1% per fill, current default 0.05%.
  9. No tax advice.
  10. No warranty. Limitation of liability.
  11. Governing law: TBD by entity choice (lawyer call).
- [ ] `docs/legal/privacy-policy.md` — draft. Sections:
  1. Data collected: TG user ID, wallet address, encrypted agent key, trade metadata.
  2. Data NOT collected: name, email, phone, IP beyond 24h.
  3. No analytics that ID users (no Google Analytics, no Mixpanel with PII).
  4. KMS encryption at rest.
  5. GDPR rights: access, delete (delete = revoke + DB purge).
  6. Cookies: session only (mini-app).
- [ ] `docs/legal/disclaimers.md` — short, sharp, embeddable.
- [ ] **Lawyer review:** budget $300–$800 from first month-1 revenue. Do not pay upfront. Acceptable to launch beta (M7) without lawyer; M9 public launch requires sign-off. Find a crypto-fluent solo lawyer via referral.

### 7.7 Email & ops stack

- [ ] **Primary mailbox:** Proton Mail Plus (~$4/mo, paid once revenue >$0) OR Cloudflare Email Routing → Gmail (free). Recommend **Cloudflare Routing → Gmail** for free start, migrate to Proton later.
- [ ] Aliases: `hello@`, `security@`, `legal@`, `support@`, `abuse@`.
- [ ] `security@` PGP key generated, public key published at `whalepod.trade/.well-known/pgp.asc` (added in U14).

### 7.8 Bookkeeping & revenue wallet hygiene

- [ ] **Builder revenue wallet** — fresh address, never used for anything else. Hardware wallet (Ledger). Public address can go in docs/transparency page.
- [ ] **Operating wallet** — separate fresh address for paying infra bills. Funded by periodic transfers from builder wallet.
- [ ] **Personal wallet** — NEVER touches WhalePod funds. Separate.
- [ ] Save addresses in `docs/private/wallets.md` (gitignored, copy in 1Password).
- [ ] Tax tracking: every transfer between wallets logged in a simple Google Sheet `Date | From | To | Asset | Amount | Reason | TxHash`. Set up Koinly or similar after first quarter only.

### 7.9 Free-tier infrastructure — signup order

Sign up in this order. Use the same hardware-2FA-protected email and a unique 1Password-generated password per service.

| #   | Service                     | Purpose                                   | Free tier                                                               | Upgrade trigger                                           |
| --- | --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | **Cloudflare**              | DNS, WAF, Email Routing, Pages            | Indefinite free tier sufficient                                         | Probably never                                            |
| 2   | **GitHub**                  | Repos, CI, CodeQL, Dependabot             | Free for public repos; private repos free with limited Actions minutes  | When CI minutes burned through (~2000/mo)                 |
| 3   | **Vercel**                  | Landing + mini-app hosting                | Hobby tier: 100GB bandwidth/mo                                          | >100GB bandwidth = ~50K DAU = good problem                |
| 4   | **Fly.io**                  | Bot + WS consumer + order router          | 3 shared-cpu-1x 256MB VMs free                                          | DAU > ~200 or memory > 256MB                              |
| 5   | **Supabase**                | Postgres + auth (we don't use their auth) | 500MB DB, 2GB bandwidth                                                 | 500MB DB ~ 6 months of fills at our scale                 |
| 6   | **Upstash**                 | Redis (rate-limit, session, queue)        | 10K commands/day free                                                   | DAU > ~50                                                 |
| 7   | **Sentry**                  | Error tracking                            | 5K errors/mo free                                                       | Errors > 5K = different problem to solve                  |
| 8   | **Better Stack** (or Axiom) | Logs + uptime                             | 1GB logs/mo free, free uptime monitoring                                | Log volume                                                |
| 9   | **AWS** (or GCP)            | KMS for envelope encryption               | KMS: $1/key/mo, $0.03 per 10K decrypts — _cheapest paid item, ~$2–5/mo_ | Launch day. **This is the one non-free service. Pay it.** |
| 10  | **Hetzner / OVH** (reserve) | VPS backup if Fly.io fails                | $5/mo cheapest VM                                                       | Only on outage                                            |

**Total monthly burn at zero revenue:** ~$5/mo (KMS only). Acceptable.

### 7.10 Files to create now (templates ready to paste)

#### `SECURITY.md`

```markdown
# Security Policy

## Reporting a Vulnerability

Email security@whalepod.trade with PGP-encrypted (key at /.well-known/pgp.asc) details:

- Description
- Reproduction steps
- Impact assessment

We acknowledge within 72 hours, fix critical issues within 7 days, and credit
researchers in a public "thank-you wall" at whalepod.trade/security/credits
(opt-in).

No monetary bounty at this time. We will offer one once revenue allows.

## Scope

In-scope:

- Bot order routing
- Mini-app wallet approval flow
- Agent key custody
- Anything that could cause user fund loss or unauthorized order placement

Out-of-scope:

- Hyperliquid protocol itself (report to Hyperliquid)
- Telegram platform
- Issues requiring physical access to user device
- Self-XSS, clickjacking on pages without sensitive actions
- Rate limits

## Out-of-Scope Behavior

WhalePod is a non-custodial frontend. WhalePod cannot withdraw user funds —
this is enforced by the Hyperliquid protocol, not by us. Reports demonstrating
unauthorized withdrawal will be treated as critical and acknowledged within 24h.
```

#### `BUS_FACTOR.md` (private repo only)

```markdown
# Bus Factor Recovery

If the founder is incapacitated, the trusted recovery party
(name: **_, email: _**, signal: \_\_\_) is authorized to:

1. Access the KMS master key escrow (location: \_\_\_).
2. Execute the killswitch script (path: scripts/killswitch.ts) which:
   - Sets kill_switch=true in DB
   - Halts the order router
3. Post a shutdown notice on @whalepod_news Telegram channel
   (credentials: 1Password vault item \_\_\_).
4. Inform users to /revoke via the bot or directly on app.hyperliquid.xyz.

User funds are unaffected. They remain on Hyperliquid, fully controllable
by the user's main wallet without any action on our part.

Revenue wallet hardware key escrow: (location, recovery phrase split):
[Shamir secret sharing details, NOT here]
```

---

## 8. Definitions of Done — Reference

Pinned for every milestone:

1. **Code written** AND **reviewed by you the next day** with fresh eyes.
2. **Tests written** AND **passing in CI** AND **coverage report posted**.
3. **Security checks** from Phase 2 checklist for that unit ticked.
4. **Documentation** updated (`README`, `docs/`, schema diagrams).
5. **Telemetry** emits (logs/metrics/traces verified in Better Stack).
6. **Rollback plan** documented in unit's PR description.

Skipping any of the six = unit is not done.

---

## 9. Kill Criteria

Numerical signals. If observed, **stop and re-evaluate** — do not "push through".

### During Phase 3 build

| Signal                                                       | Milestone  | Action                                                                                |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| Onboarding median time >90s after 10 test users              | End of M2  | Halt M3 — redesign mini-app. Up to 2-week pause.                                      |
| Fill mirror latency >2s p95 on testnet                       | End of M3  | Halt — debug WS pool.                                                                 |
| Test users abandon mid-onboarding >50%                       | End of M2  | Halt — UX rebuild.                                                                    |
| Closed beta (M7) <50% complete first mirror                  | Beta day 3 | Pause beta, fix, restart.                                                             |
| Any incident causing user fund movement we did not authorize | Anytime    | **Stop everything. Killswitch. Disclose publicly. End of project until root-caused.** |
| Competitor ships polished HL TG copy-trading bot mid-build   | Anytime    | Pause, re-scope wedge (e.g., go niche: HIP-3 pre-IPO copy-trading) or kill.           |

### Post-launch (Month 1)

| Signal                         | Threshold | Action                                                       |
| ------------------------------ | --------- | ------------------------------------------------------------ |
| Cumulative fees day 14         | <$500     | High-confidence miss. Audit wedge. Consider pivot.           |
| Cumulative fees day 30         | <$2,000   | **Kill or pivot.** Wedge is wrong.                           |
| Cumulative fees day 30         | $2K–$5K   | Underperform. Iterate, do not pivot. Set day-60 target.      |
| Cumulative fees day 30         | $5K–$10K  | Floor cleared. Continue.                                     |
| Cumulative fees day 30         | >$10K     | Base case. Scale.                                            |
| Cumulative fees day 30         | >$30K     | Exceptional. Begin hiring (1 ops contractor first, not eng). |
| K-factor day 30                | <0.05     | Viral loop broken. PnL-card redesign priority 1.             |
| Onboarding completion day 30   | <40%      | Critical defect — emergency UX work.                         |
| Day-7 retention                | <30%      | Habit loop weak. Notification/trigger rework.                |
| Any unauthorized fund movement | Any       | Killswitch. Full stop.                                       |

---

## 10. What I Need From You To Proceed

1. **Confirm name + domain bought.** Reply with the exact domain you bought (`whalepod.trade`?) and X handle reserved.
2. **Confirm Telegram bot username reserved** via BotFather.
3. **Confirm AWS (or GCP) account created** for KMS. This is the one paid dependency — needed before U6.
4. **Confirm Phase 1 accepted as written**, with any objections.
5. **Confirm you've generated A1–A7** with Nano Banana Pro using `docs/brand/image-prompts.md`. If any template (A5–A7) renders data text or `{REF}`, regenerate.

Once 1–5 are green, I begin **Phase 2: Technical Architecture & Security Plan**, which gates the actual code in Phase 3.
