# WhalePod — Launch Runbook (Zero → $5k Month 1)

> Telegram-native copy-trading on Hyperliquid perps. Default fee 5 bps via Builder Codes. Goal: **$5,000 protocol revenue in the first 30 days** of public launch.
>
> Revenue math (sanity check): 5 bps = 0.05% of notional.
> `$5,000 / 0.0005 = $10,000,000 of mirrored notional / month`
> = `~$333k / day` of copy-trade volume.
> = realistically **80–150 active users** averaging **$2.5k–$4k/day** each.

This document is the complete operator playbook. Every section is a literal checklist. Do them in order. Nothing is skipped.

---

## Table of Contents

0. [What you're shipping (1-minute recap)](#0-what-youre-shipping)
1. [Pre-flight: accounts you need](#1-pre-flight-accounts-you-need)
2. [Provision infra](#2-provision-infra)
3. [Hyperliquid: register your Builder Code](#3-hyperliquid-register-your-builder-code)
4. [Telegram: create the bot + mini-app](#4-telegram-create-the-bot--mini-app)
5. [Repo: env, secrets, DB migration](#5-repo-env-secrets-db-migration)
6. [Smoke test on testnet](#6-smoke-test-on-testnet)
7. [Deploy to production](#7-deploy-to-production)
8. [Day-0 sanity checks (after deploy)](#8-day-0-sanity-checks)
9. [Curate whales (the single most important growth lever)](#9-curate-whales)
10. [Marketing playbook — every X post, every TG message](#10-marketing-playbook)
11. [Day-by-day launch schedule (T-7 → T+30)](#11-day-by-day-launch-schedule)
12. [Daily operator routine (~30 min/day)](#12-daily-operator-routine)
13. [Metrics that matter + dashboards](#13-metrics-that-matter)
14. [Incident response](#14-incident-response)
15. [Legal, compliance, geo-blocking](#15-legal-compliance-geo-blocking)
16. [Stretch: what to build in month 2 if you hit $5k](#16-month-2-stretch)
17. [Appendix A — copy-paste post templates](#appendix-a-copy-paste-post-templates)
18. [Appendix B — env var reference](#appendix-b-env-var-reference)

---

## 0. What you're shipping

A Telegram bot that lets a user:

1. Tap a link → open the WhalePod mini-app → connect a Hyperliquid wallet → mint an **agent wallet** with capped fee permission (≤10 bps; default 5 bps).
2. `/follow 0x<whale_address>` — every fill that whale makes is mirrored on the user's account (sized by their equity), routed via your **Builder Code** so the 5 bps fee accrues to your treasury.
3. `/pause`, `/kill`, `/fee`, `/tp`, `/sl`, `/pnl`, `/leaderboard`, `/notify`, `/share` — everything else.

The user keeps custody. Worst case (your bot is compromised) the attacker can place trades on HL but **cannot withdraw funds** (agent wallets have no withdraw permission) and **cannot charge more than the user-approved fee cap** (DB CHECK + on-chain HL enforcement).

---

## 1. Pre-flight: accounts you need

Create accounts (or confirm you already have them). Keep a password manager open.

| # | Service | Why | Cost month 1 |
|---|---|---|---|
| 1 | **Hyperliquid mainnet account** (this is your **treasury** — receives builder-code fees) | Required to register builder code | ~$2 gas |
| 2 | **Hyperliquid testnet account** | Smoke testing | free |
| 3 | **AWS account** (us-east-1 region) | KMS for sealing agent keys | <$5 |
| 4 | **Neon** (or Supabase/RDS) — Postgres 15+ | App DB | $0–$19 |
| 5 | **Upstash Redis** — global, eviction off | Streams + caches | $0–$10 |
| 6 | **Render / Fly.io / Railway** — Node 22 runtime | Host the bot process | $7–$25 |
| 7 | **Vercel** | Host the mini-app (WebApp) | $0 |
| 8 | **Cloudflare** | DNS + (optional) WAF for mini-app | $0 |
| 9 | **Telegram account** + a throwaway dev account for testing | Bot ops | $0 |
| 10 | **X (Twitter)** brand account `@whalepod` (or your name) | Marketing | $0 (or $8 for blue) |
| 11 | **Discord** (optional — most users don't want it; TG group is enough) | Support | $0 |
| 12 | **Domain** — `whalepod.trade` (or your pick) | Mini-app + landing | ~$15/yr |
| 13 | **PostHog** or **Plausible** (analytics) | Funnel tracking | $0 |
| 14 | **Sentry** (error tracking) | Crash visibility | $0 |
| 15 | **GitHub** | Source + Actions for CI | $0 |

Total month-0 fixed cost: **~$50–$100**.

---

## 2. Provision infra

### 2.1 AWS KMS (seals every user's agent private key)

```bash
aws kms create-key \
  --description "WhalePod agent-key wrapping KEK" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --region us-east-1
```

Take the returned `KeyId`.

> **Skip the alias step.** Aliases are cosmetic and require `kms:CreateAlias` permission, which the runtime IAM user (correctly) does not have. Just put the bare key ID (or full ARN) directly into `KMS_KEY_ID` — the app handles both. If you want an alias, create it from the AWS console while logged in as the root account or an admin, not from the runtime user.

Create an IAM user `whalepod-bot` with **only** these KMS actions on that key ARN:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
    "Resource": "arn:aws:kms:us-east-1:<acct>:key/<KeyId>"
  }]
}
```

Generate an access key for that user. **Save** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` — they go into `.env`.

### 2.2 Postgres (Neon recommended for month 1)

1. Create a new project `whalepod-prod`, region close to your bot host (us-east).
2. Create a database `whalepod`.
3. Copy the **pooled** connection string (you want PgBouncer in front for serverless).
4. Save as `DATABASE_URL`.
5. Create a **read replica** branch `whalepod-readonly` — point analytics queries here so reads never block trade writes.

### 2.3 Upstash Redis

1. Region: `us-east-1` (match Postgres).
2. Eviction: **OFF** (streams must not be evicted).
3. TLS: ON.
4. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### 2.4 Sentry

1. Create project `whalepod-bot` (Node).
2. Copy DSN → `SENTRY_DSN`.

### 2.5 Domain + DNS (Cloudflare)

1. Register `whalepod.trade` (or your choice).
2. Cloudflare: add the domain, set nameservers at registrar.
3. Records:
   - `app.whalepod.trade` → CNAME to your Vercel app.
   - `whalepod.trade` → CNAME to landing page (Vercel or Webflow).

---

## 3. Hyperliquid: register your Builder Code

> This is the line item that earns you the fee. Get it right.

### 3.1 Read first

- Read [Hyperliquid Builder Codes docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#builder-fees) (link may have moved — search "Hyperliquid builder fees").
- Builder fee for **perps** is capped by HL at 100 tenths-of-bp = 10 bps. WhalePod defaults to **50 tenths-of-bp = 5 bps**. Constant lives at `BUILDER_FEE_PERP_CAP_TENTHS_BP`.

### 3.2 Mainnet

1. Fund your treasury wallet with **~$50 USDC on Arbitrum** and bridge into HL.
2. From that wallet, sign and submit `setBuilderFee` (or use the official HL UI when available) with:
   - `builder = <your treasury address>` (lowercase 0x..)
   - `maxFeeRate = "0.001"` (decimal of 10 bps)
3. **Verify** by hitting the HL info endpoint `userBuilderFee` — it must return the same builder + rate.
4. Save the builder address as `HL_BUILDER_ADDRESS` in `.env`.

### 3.3 Testnet

Repeat the exact same flow on **testnet** with a separate wallet. You'll use this for smoke tests in §6.

### 3.4 Sanity

Your bot signs L1 Agent actions with `builder = HL_BUILDER_ADDRESS` and `f = 50` (tenths of a bp, i.e. 5 bps). Every fill that whale executes via your mirror will tag the fee to that address. **HL settles the fees daily to that wallet.**

---

## 4. Telegram: create the bot + mini-app

### 4.1 BotFather

Open `@BotFather` in Telegram:

1. `/newbot` → name `WhalePod`, username `WhalePodBot` (or whatever's free; you'll need it in env as `BOT_USERNAME`).
2. Save the **token** → `TG_BOT_TOKEN`.
3. `/setdescription` → "Copy-trade Hyperliquid whales from Telegram. 5 bps. Non-custodial."
4. `/setabouttext` → same, shorter.
5. `/setuserpic` → upload your logo (1024×1024).
6. `/setcommands` → paste:
   ```
   start - Open WhalePod
   wallet - Show connected wallet & fee
   follow - Mirror a whale: /follow 0x...
   unfollow - Stop mirroring a whale
   pause - Pause all subscriptions
   resume - Resume all subscriptions
   fee - Set builder fee 0–100 (tenths of a bp)
   tp - Take-profit: /tp 0x... 250
   sl - Stop-loss: /sl 0x... 250
   kill - Emergency stop (no mirrors will be sent)
   unkill - Clear emergency stop
   pnl - Show realized + unrealized P&L
   leaderboard - Top traders by realized P&L
   notify - /notify on|off|compact|full
   share - Get your invite link
   help - Show this menu
   ```
7. `/newapp` (under your bot) → mini-app:
   - Title: `WhalePod`
   - Description: short.
   - Photo: 640×360.
   - GIF: optional.
   - Web App URL: `https://app.whalepod.trade`
   - Short name: `whalepod` → this builds `t.me/WhalePodBot/whalepod`.

### 4.2 Bot Menu Button

`/setmenubutton` → "Open WhalePod" → URL `https://app.whalepod.trade`.

### 4.3 Group (do this on day T-3, see §11)

- Create `@WhalePodChat` public group.
- Pin: "Read /rules. Bot support: @<your_handle>. No financial advice."
- Add yourself + 2 co-pilots as admins.
- Slow-mode 5s. Anti-spam: Combot or Group Help Bot.

---

## 5. Repo: env, secrets, DB migration

### 5.1 `.env.production`

Create alongside the deploy target (never commit it). Use `.env.example` as the schema — every variable in `appEnvSchema` must be set.

See [Appendix B](#appendix-b-env-var-reference) for the full list.

### 5.2 Secrets manager

Render: paste each as an env var.
Fly.io: `fly secrets set KEY=value` for each.
GitHub Actions: store as repository secrets for CI deploys.

**Never** put `TG_BOT_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `UPSTASH_REDIS_REST_TOKEN`, or `DATABASE_URL` in code, in logs, or in screenshots.

### 5.3 Database migrations

```bash
cd /workspaces/U
DATABASE_URL=<prod_url> npx drizzle-kit push
```

This applies all 4 migrations:
- `0000_initial.sql`
- `0001_check_constraints.sql`
- `0002_subscriptions_tp_sl.sql`
- `0003_fills_realized_pnl.sql`
- `0004_users_notify_prefs.sql`

Verify in psql:
```sql
\dt
SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position;
-- expect: id, tg_user_id, tg_username, main_wallet, agent_address,
--         agent_key_ct, agent_key_iv, agent_key_tag, agent_dek_ct,
--         approved_max_fee_tenths_bp, current_fee_tenths_bp,
--         equity_floor_usd, kill_switch, notify_muted, notify_compact,
--         geofence_country, created_at, revoked_at
```

---

## 6. Smoke test on testnet

> Do this **before** any production traffic. It's a read-only HL probe + a write probe on testnet.

```bash
cd /workspaces/U
HL_NETWORK=testnet npm run smoke -w @whalepod/bot
```

Expected output: prints HL meta universe, your treasury equity, sample mark prices. No errors.

Then end-to-end on testnet:

1. Run the bot pointing at testnet:
   ```bash
   HL_NETWORK=testnet \
   TG_BOT_TOKEN=<your_dev_bot_token> \
   DATABASE_URL=<a_throwaway_dev_db> \
   ...rest of env... \
   npm run start -w @whalepod/bot
   ```
2. From your test TG account: `/start`, complete onboarding in mini-app with a testnet wallet.
3. `/follow 0x<a_known_active_testnet_whale>`
4. Wait for that whale to trade. Confirm:
   - You get a TG push within ~3s of their fill.
   - Your testnet account shows a mirror fill in HL.
   - `/pnl` returns sensible numbers.
   - `/notify off` mutes pushes; `/notify on` restores.
   - `/kill` stops new mirrors; `/unkill` resumes.
5. Tail logs: zero ERROR-level entries during a 30-minute soak.

If anything fails — **do not proceed**. Fix it; reread §5; rerun §6.

---

## 7. Deploy to production

### 7.1 Render (recommended for month 1)

1. Connect GitHub repo `Tonyflam/U`.
2. New **Web Service**:
   - Runtime: Node 22.
   - Build: `npm ci && npm run build -w packages/schema && npm run build -w apps/bot`
   - Start: `node apps/bot/dist/start.js`
   - Region: `Oregon` or `Virginia` (match infra).
   - Instance: **Starter ($7)** is fine for first 200 users. Scale to **Standard ($25)** once you hit ~50 concurrent mirror events/min.
   - Health check: `GET /healthz` (the fastify app responds 200).
   - Auto-deploy: ON for `main`.
3. Paste all env vars from §5.1.
4. Click **Deploy**.
5. After it's live: in BotFather `/setdomain` → `app.whalepod.trade`. Then set webhook:
   ```bash
   curl -F "url=https://<render-url>/tg/webhook" \
        https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook
   ```
6. Sanity:
   ```bash
   curl https://api.telegram.org/bot<TG_BOT_TOKEN>/getWebhookInfo
   ```
   `pending_update_count` should be 0 and `last_error_date` should be null.

### 7.2 Vercel (mini-app)

1. New project → import `apps/web` (or wherever your mini-app lives).
2. Build: `npm run build`. Output: `dist`.
3. Env: `VITE_API_BASE=https://<render-url>`, `VITE_BUILDER_ADDRESS=<your treasury>`, `VITE_NETWORK=mainnet`.
4. Domain: `app.whalepod.trade`.

### 7.3 First-canary

Onboard yourself first. Connect a real wallet with **$200 max**. Follow one well-known active whale. Let it run for 2 hours. Tail logs.

If 2 hours pass with mirrored fills + zero errors + fees showing up in HL builder dashboard → you're live.

---

## 8. Day-0 sanity checks

Run all of these within 1 hour of going live. Save the screenshots — you'll post them.

| # | Check | How | Pass criteria |
|---|---|---|---|
| 1 | DB writes | `SELECT count(*) FROM users` after you onboard | ≥1 |
| 2 | Agent key sealed | `SELECT octet_length(agent_key_ct) FROM users LIMIT 1` | >0 |
| 3 | Audit log | `SELECT action FROM audit_log ORDER BY id DESC LIMIT 5` | shows `onboard`, `subscribe`, `mirror_submitted` |
| 4 | Fills row written | `SELECT * FROM fills WHERE is_mirror=true LIMIT 1` (after first mirror) | 1 row, `realized_pnl_usd` NULL until close |
| 5 | Builder fee in HL | HL UI → builder dashboard for your treasury | shows your fill |
| 6 | TG push received | The bot DM'd you the fill | yes |
| 7 | `/pnl` | run command | renders without error |
| 8 | `/leaderboard` | run command | shows you (entry of 1 is fine) |
| 9 | Mute path | `/notify off`, force a mirror, no DM arrives | yes |
| 10 | Kill switch | `/kill`, force a whale fill, **no mirror** placed | confirm in HL |
| 11 | Geo block | (optional) curl onboarding endpoint via a blocked-country VPN | gets refused |
| 12 | Sentry | force an error, confirm it lands | yes |

---

## 9. Curate whales

> **This is the single biggest lever for hitting $5k.** Users follow whales who make money. If your default `/leaderboard` of whales is mid, retention dies in week 1.

### 9.1 How to pick whales

Manually pick **10–15 whales** before launch. Criteria, in order:

1. **Active**: ≥10 fills/day average (otherwise users feel nothing's happening and unsubscribe).
2. **Profitable**: positive 30-day realized P&L on HL.
3. **Reasonable risk**: max drawdown <25% on 90d. No 50× degens — one liquidation tanks your reputation.
4. **Notional**: median trade ≥$10k (gives users dust-free mirror sizing).
5. **Coin variety**: at least 4 different coins (don't have all 10 whales doing only BTC).

Sources to find them:
- HL leaderboard (sort by 30d PnL).
- `@hyperliquid_news` on X — they post big winners.
- Whale-tracker tools (HypurrScan etc.).

### 9.2 Seed them in the DB

```sql
INSERT INTO whales (address, alias, added_by) VALUES
  ('0x...', 'BigDog', '<your_user_id>'),
  ('0x...', 'EthScalper', '<your_user_id>'),
  ...;
```

Make the aliases **memorable** and **not financially-advising** (avoid "10x" or "guaranteed").

### 9.3 Refresh weekly

Every Sunday, prune whales who went cold or rugged. Add 2 new ones. Announce in TG + X (see §10 templates).

---

## 10. Marketing playbook

> Goal: **100 onboarded users by end of week 2.** Each must average $3k/day mirrored notional. The math: 100 × $3k × 30 = $9M notional × 0.05% = $4.5k. So 120 users gets you to $5.4k. Aim for 120.

### 10.1 Channels in order of leverage

1. **Hyperliquid Discord + TG groups** (free, high-intent users) — most important.
2. **Crypto Twitter / X** — slower compound but builds trust.
3. **Whale shoutouts** — when a whale you mirror posts a win, quote-tweet with "WhalePod followers caught this auto."
4. **Referral program** — `/share` mints a unique code. (Already built. See §10.6 for how to incentivize.)
5. **Paid:** *skip in month 1.* Don't pay for ads until your onboarding-to-first-fill conversion >70%.

### 10.2 X (Twitter) cadence

- **Pre-launch (T-7 → T-1)**: 1 build-in-public post/day. Show screenshots, talk about your fee model, post your whale picks. (Templates in [Appendix A.1](#a1-pre-launch-x-posts).)
- **Launch day (T-0)**: 1 hero post pinned. Quote-RT it from a co-builder account if you have one.
- **Week 1**: 2 posts/day. One product (a new feature, a screenshot of /leaderboard), one community (RT a user's win, "we mirrored 27 trades today").
- **Week 2–4**: 1 post/day minimum + reply to every HL ecosystem post that's relevant.

### 10.3 Telegram cadence

- **Post in your own group**: 1 update/day minimum. New whales, fee numbers, fixes shipped.
- **Cross-post in Hyperliquid TG / chat groups**: only when it's *useful* (a new whale you added, a feature). Spamming = ban.

### 10.4 Reach out to whales personally (DM)

This is unglamorous, high-ROI work. For the 10 whales you seed:

- Find their TG/X via on-chain detective work (HL leaderboard sometimes links).
- Send a short DM: *"Hi. We built a tool that lets people mirror your trades on HL. We don't take a cut from you; users pay a 5 bps fee on their own fills. ~30 mirror followers so far. If you tweet/post about us, we'll send the first 100 referrals to your bag (or a payout) — happy to discuss."*

If even 2 say yes and post once, you get free distribution into thousands of whale-follower eyeballs. **This alone can hit $5k.**

### 10.5 Hyperliquid ecosystem ask

Hyperliquid runs a builder-codes grant + visibility program. As soon as you have **any** users:

- DM the HL team account on X.
- Apply to their builder-codes showcase (if listed).
- Post in their Discord `#dev-showcase` channel **once** with a short demo video (Loom, 60s).

### 10.6 Referral incentives

Out-of-the-box `/share` mints a code but pays nothing. For month 1, manually pay the top 3 referrers at end of month:

- 1st place: $200 in USDC.
- 2nd: $100.
- 3rd: $50.

Announce at launch (X post template A.3). Track via `referrals_attribution` table — query at month end.

### 10.7 Content that converts

A. **The fee comparison table** — post one image:

| Platform | Fee | Custody |
|---|---|---|
| Centralized copy-trader X | 20% of profits | They hold |
| Hyperliquid + manual copy | gas + slip + your time | You |
| **WhalePod** | **5 bps (0.05%) of notional** | **You (agent key only)** |

B. **The "we caught this" win post** — every time a mirrored whale closes a big win, tweet:
> Whale `0xabc…1234` just closed +$45k on ETH long. WhalePod followers auto-mirrored at proportional size. 27 followers, avg $185 P&L per follower, 0.05% fee. No subscription. No custody.

C. **The transparency post** (weekly) — Sunday evening:
> Week N WhalePod stats:
> · Active users: NNN
> · Mirrored notional: $X.XXm
> · Builder fees earned: $X,XXX
> · Whales added: N
> · Top whale (by user PnL): @alias
> No marketing budget. No VCs. Built in N days.

---

## 11. Day-by-day launch schedule

> Assumes T-0 = launch day. Move T-0 to the day all of §5 and §6 are green.

### T-7 (one week out)

- [ ] Buy domain. Set up Vercel + Render shells.
- [ ] Provision AWS KMS, Neon, Upstash.
- [ ] Create `@WhalePodBot` in BotFather.
- [ ] Pick your 10 seed whales. Validate them on HL leaderboard.
- [ ] X post A.1.1 (intro tease).

### T-6

- [ ] Migrate DB. Seed whales.
- [ ] Deploy to Render. Webhook live.
- [ ] Smoke testnet (§6).
- [ ] X post A.1.2 (screenshot of /pnl).

### T-5

- [ ] First canary — onboard yourself with real wallet, $100 cap.
- [ ] 2-hour soak. Tail logs. Fix any noise.
- [ ] X post A.1.3 (whale you'll feature on launch).

### T-4

- [ ] Onboard 3 friends. Have them follow 2 whales each. Watch them in production.
- [ ] Fix any UX paper cuts they raise.
- [ ] DM 5 whales (template §10.4).

### T-3

- [ ] Create `@WhalePodChat` TG group. Pin rules. Add admins.
- [ ] X post A.1.4 (countdown -3).
- [ ] Post in **one** HL ecosystem TG group with a soft mention.

### T-2

- [ ] Run /pnl + /leaderboard against the small group. Confirm rendering.
- [ ] Final infra dry-run: kill the bot, restart. Verify it picks up the stream group cleanly.
- [ ] X post A.1.5 (-2: "we go live in 48h. 10 whales lined up.")

### T-1

- [ ] Sleep.
- [ ] Last status check: error logs, builder dashboard, DB row counts.
- [ ] Prepare hero launch post (A.2.1) as a draft.

### T-0 (launch day)

- [ ] 09:00 UTC — confirm bot, mini-app, DB green.
- [ ] 10:00 UTC — **POST** hero thread A.2.1 on X.
- [ ] 10:05 — share in Hyperliquid Discord `#dev-showcase`.
- [ ] 10:10 — share in 3 relevant TG groups (don't spam — one message, useful, with link).
- [ ] 10:15 — DM the 5 whales again with "we're live."
- [ ] All day — respond to **every single reply** within 15 min. Add every onboarded user to TG group manually with welcome DM.
- [ ] 18:00 UTC — first daily transparency post (A.4.1).

### T+1 to T+7

- [ ] Daily 09:00 UTC: post yesterday's stats (template A.4).
- [ ] Daily: ship one tiny visible improvement (better /pnl, a new whale, a faster push) — post about it.
- [ ] By end of week 1: **target 30 onboarded users**, **$1m mirrored notional**, **$500 in fees**.

### T+8 to T+14

- [ ] Add referral payout tracker public dashboard (you can be lazy: pinned message in TG group, updated daily).
- [ ] Start one **"trade replay"** post per day: "Whale X did this, here's how it played for followers."
- [ ] **Target by end of week 2**: 80 users, $4m notional, $2k fees.

### T+15 to T+30

- [ ] Run **one** giveaway: "RT + reply with your /share link → 3× $100 USDC randomly drawn at end of week."
- [ ] Reach out to 2 micro-influencers (5k–30k followers, HL-focused). Offer them an affiliate split (manually paid).
- [ ] **Target by end of month 1**: 120 users, $10m notional, **$5k fees**.

---

## 12. Daily operator routine (~30 min/day)

Same time every day. Discipline > heroics.

1. **(5 min) Check error tail**: `render logs --tail` or Sentry. Anything new? File a ticket on yourself.
2. **(5 min) DB pulse**:
   ```sql
   SELECT
     (SELECT count(*) FROM users WHERE revoked_at IS NULL) AS active_users,
     (SELECT count(*) FROM subscriptions WHERE paused=false) AS active_subs,
     (SELECT count(*) FROM fills WHERE is_mirror=true AND ts > now() - interval '24 hours') AS fills_24h,
     (SELECT sum(builder_fee_usd::numeric) FROM fills WHERE is_mirror=true AND ts > now() - interval '24 hours') AS fees_24h_usd;
   ```
3. **(5 min) Builder dashboard on HL**: confirm fee accrual matches DB.
4. **(5 min) TG support**: answer the new questions in your group.
5. **(10 min) Post one thing**: stats post (template A.4), new whale (A.5), or replay (A.6). One per day, no exceptions.

---

## 13. Metrics that matter

Track these in a simple Google Sheet, updated daily.

| Metric | Target end of month 1 | Why |
|---|---|---|
| Active users | 120 | Direct revenue driver |
| Active subscriptions / user | 2.0 | Diversification = retention |
| Mirrored notional / day | $333k | Math to $5k |
| Builder fees earned / day | $167 | Same |
| **Builder fees earned, month total** | **$5,000** | The goal |
| Onboarding completion rate | >70% | Otherwise marketing wastes spend |
| Day-7 retention | >50% | Otherwise the funnel leaks |
| Day-30 retention | >35% | Otherwise no compounding |
| Push notification delivery latency p95 | <5s | UX feel |
| Mirror submission latency p95 | <3s | Catch the price |
| /pnl renders without error | 100% | Trust |
| Errors per 1000 mirror attempts | <5 | Engineering health |

Set up a Looker/Metabase dashboard against the read replica.

---

## 14. Incident response

### 14.1 Severity levels

| Sev | Example | Response time |
|---|---|---|
| **S0 — funds at risk** | KMS key disclosed, agent keys leaked | **immediate** — see 14.2 |
| **S1 — trading down** | Bot crashing, no mirrors landing | <15 min |
| **S2 — degraded** | High latency, push delays | <2h |
| **S3 — cosmetic** | /pnl off-by-1 | next day |

### 14.2 S0 runbook (memorize this)

1. **Toggle global kill**: set env `GLOBAL_KILL=true`, redeploy. The bot will refuse all `submitMirror` calls.
2. **Revoke the KMS key** in AWS console (disables decryption of every agent key).
3. **Post in TG group**: "We've detected a security incident. We've paused all mirroring as a precaution. No funds can be withdrawn by the bot. You're safe. Updates here as we know more."
4. Forensics: pull the audit log. `audit_log` is append-only; the last writes will tell you what happened.
5. Rotate the KEK (create new key in §2.1, re-encrypt every `agent_dek_ct` via a backfill script, swap alias).

### 14.3 S1 runbook

1. Tail Render logs. Look for the first ERROR.
2. Check upstream: Hyperliquid status, Upstash status, Neon status.
3. If HL is down: post in TG "HL is down, we're paused with them. Will resume automatically."
4. If our bug: revert the last deploy (`render rollback`) while you fix forward.

### 14.4 S2/S3

Add to issue tracker, ship in the daily improvement slot.

---

## 15. Legal, compliance, geo-blocking

> **Not legal advice. Talk to a lawyer in your jurisdiction before launch.** The notes below are operational defaults.

### 15.1 Geo-blocking

Hyperliquid blocks US users by default. WhalePod inherits that block via the `geoCapture` middleware. **Do not weaken it.**

Set in env:
```
GEOFENCE_BLOCKED_COUNTRIES=US,KP,IR,SY,CU,RU,BY
```

(Adjust per your counsel.) The mini-app + bot will refuse onboarding from those ISO-3166-1 alpha-2 codes.

### 15.2 Terms of service + privacy

Ship a `/terms` and `/privacy` page on the landing site. Minimal viable language:

- WhalePod is a non-custodial routing tool.
- We do not custody funds. Agent keys are sealed with AWS KMS.
- Past performance is not indicative of future results.
- You agree not to use the service from the listed restricted jurisdictions.
- We log Telegram user IDs, wallet addresses, and trade events for service operation. We do not sell data.

Link both from the mini-app footer **before** the connect-wallet button.

### 15.3 No financial advice

In **every** TG message, X post, and mini-app screen, avoid words like *"guaranteed,"* *"risk-free,"* *"will moon,"* *"sure thing."* Stick to factual past performance ("whale X is up Y% over 30d on HL").

### 15.4 KYC/AML

For month 1, you're a thin routing layer with no custody. KYC is generally not required for non-custodial routing of derivatives, **but this varies by jurisdiction**. Talk to counsel before scaling to a Series A profile.

---

## 16. Month-2 stretch

If you hit $5k in month 1, the next features (in order of ROI) are:

1. **Position-based mirror** — instead of mirroring each fill, snapshot the whale's net position daily and rebalance the follower toward it. Cheaper for users, less noise, better retention.
2. **Multi-whale rebalancer** — user picks 3 whales, you size proportionally. Big UX win.
3. **Web app (not just TG mini-app)** — same backend, browser frontend. Opens up non-TG users.
4. **Higher fees tier** — opt-in 10 bps "premium" plan with priority execution + exotic whale slots.
5. **Affiliate v2** — on-chain referral payouts straight from the builder-fee stream, no manual ops.

---

## Appendix A — copy-paste post templates

### A.1 Pre-launch X posts

#### A.1.1 (T-7: tease)
> Building a thing.
>
> Copy-trade Hyperliquid whales from inside Telegram. 5 bps fee. You keep your keys (agent wallets only, no withdraw).
>
> No subscription. No vault. No middleman taking your edge.
>
> Going live next week. Drop a 🐳 if you want early access.

#### A.1.2 (T-6: product screenshot)
> WhalePod /pnl, working on testnet 👇
>
> [image of /pnl reply]
>
> Realized + unrealized broken out per coin. Synced from your real HL fills. No spreadsheet.
>
> 6 days to mainnet.

#### A.1.3 (T-5: a whale you'll seed)
> Whale we're adding to WhalePod at launch:
>
> `0x...1234`
> · 30d realized P&L: +$132k
> · Win rate: 61%
> · Avg trade: $42k
> · Mostly ETH + SOL
>
> Mirror them in 2 taps once we go live.

#### A.1.4 (T-3)
> WhalePod -3.
>
> Telegram bot. Copy whales on Hyperliquid. 5 bps. Non-custodial.
>
> Drop your TG handle in the replies for priority onboarding.

#### A.1.5 (T-2)
> Launch in 48 hours.
>
> 10 whales lined up. 5 bps fee. 0 custody.
>
> [Telegram link button]

### A.2 Launch-day hero thread

#### A.2.1 (T-0: pin this)
> WhalePod is live. 🐳
>
> Copy-trade Hyperliquid whales from your Telegram. Open the bot, connect wallet, /follow 0x... — every trade that whale makes, you make (scaled to your equity).
>
> Why it's different ↓ 1/

> 1/ **Non-custodial.** We never touch your funds. You sign once to authorize an agent wallet with a fee cap and no withdraw permission. Revoke any time on HL.

> 2/ **5 bps.** That's it. No subscription. No profit share. No "performance fee." Just a thin builder-code routing fee on each of your own fills. HL caps it at 10 bps and we default to half.

> 3/ **Push notifications.** When your whale fills, you get a TG message in <3s with size, fee, and realized P&L (when it closes a position). `/notify compact` for one-liners.

> 4/ **Risk controls built in.** `/kill` global stop. `/pause` per-account. `/tp` `/sl` per-whale offsets. Daily notional cap. Equity floor. Geofencing.

> 5/ **10 whales seeded** at launch — all profitable, all active, all picked by hand. Browse `/leaderboard` to see them. We rotate the list weekly.

> 6/ Open in TG → [t.me/WhalePodBot]
> Docs → [whalepod.trade]
> Source → [github link]
>
> Built in N days. No VCs. RTs welcome.

### A.3 Referral launch

#### A.3.1
> Referral program for week 1:
>
> Use `/share` in @WhalePodBot to get your invite link.
>
> Top 3 referrers at end of month split $350 USDC:
> · 1st: $200
> · 2nd: $100
> · 3rd: $50
>
> Tracked on-chain via builder fees on your referees' notional. Honest math, public leaderboard.

### A.4 Daily transparency

#### A.4.1 (T-0 evening)
> WhalePod day 1:
> · Onboarded users: N
> · Whales followed: N
> · Mirrors placed: N
> · Builder fees earned: $X
> · Bugs found and fixed: N
>
> Day 2 plan: ship faster /pnl, add 2 whales, reply to every DM.
>
> [t.me link]

#### A.4.2 (weekly Sunday)
> WhalePod week N:
> · Active users: NNN (+M)
> · Mirrored notional: $X.XXm
> · Builder fees: $X,XXX
> · Top whale (user P&L): @alias (+$Y)
> · Avg push latency: Xs
>
> Coming this week: <one thing>.

### A.5 New whale post

#### A.5.1
> New whale added to WhalePod:
>
> `0x...abcd` — alias `@<alias>`
>
> · 90d realized P&L: +$X
> · Style: <swing / scalp / position>
> · Win rate: X% on N trades
> · Coins: ETH, BTC, SOL
>
> Mirror in 2 taps → /follow 0x...abcd in @WhalePodBot

### A.6 Trade replay

#### A.6.1
> @<whale alias> just closed +$X on ETH.
>
> Entry: $E
> Exit: $X
> Hold: Xh
>
> WhalePod auto-mirrored at proportional size for N followers. Avg follower P&L: +$Y. Fee charged: $Z (5 bps).
>
> No spreadsheet. No screen-watching. /follow 0x... in @WhalePodBot.

### A.7 Telegram group templates

#### A.7.1 (group welcome — pinned)
> 👋 Welcome to WhalePod.
>
> · Copy-trade HL whales. 5 bps. Non-custodial.
> · Open the bot → @WhalePodBot → /start
> · Commands: /help
> · Support: tag an admin
> · Bug? DM @<your_handle> with a screenshot.
>
> Rules:
> 1. No shilling other tools / projects.
> 2. No financial advice. We post stats, not predictions.
> 3. Be civil. One warning, then ban.

#### A.7.2 (whenever a whale you mirror posts publicly)
> 🚨 Whale @<alias> just posted about their HL setup → [link]
>
> If you mirror them via WhalePod, you'll auto-follow whatever they do next. /follow 0x... in @WhalePodBot.

#### A.7.3 (after a clean week)
> Quick week-end note 👇
>
> WhalePod has done $X.XXm of mirrored volume across N users this week. Zero security incidents. Zero downtime > 5min.
>
> Building boring infra is the goal. Thanks for trusting it with your trades.

---

## Appendix B — env var reference

The exhaustive list. Every one must be set in production. Match these to `appEnvSchema` in `packages/config`.

```bash
# --- runtime ---
NODE_ENV=production
LOG_LEVEL=info
PORT=3000

# --- telegram ---
TG_BOT_TOKEN=xxxxxxxxx:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BOT_USERNAME=WhalePodBot
MINIAPP_URL=https://app.whalepod.trade
TG_WEBHOOK_SECRET=<32 random bytes hex>

# --- hyperliquid ---
HL_NETWORK=mainnet
HL_BUILDER_ADDRESS=0x<your treasury>
HL_INFO_URL=https://api.hyperliquid.xyz/info
HL_EXCHANGE_URL=https://api.hyperliquid.xyz/exchange

# --- postgres ---
DATABASE_URL=postgres://...neon...

# --- redis ---
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
MIRROR_STREAM_KEY=mirror-intents
MIRROR_CONSUMER_NAME=bot-1
MIRROR_BATCH_SIZE=32

# --- kms ---
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
KMS_KEY_ID=<key UUID or full key ARN — e.g. 287f9533-... or arn:aws:kms:us-east-1:ACCT:key/UUID>

# --- safety ---
GLOBAL_KILL=false
DEFAULT_FEE_TENTHS_BP=50
MAX_FEE_TENTHS_BP=100
DAILY_NOTIONAL_CAP_USD=250000
EQUITY_FLOOR_USD=50
GEOFENCE_BLOCKED_COUNTRIES=US,KP,IR,SY,CU,RU,BY

# --- observability ---
SENTRY_DSN=https://...sentry.io/...
```

---

## Closing note

Everything technical is built. The product works. The remaining variable is **execution on §10 and §11**. Marketing and whale curation are now the bottleneck — not code.

Ship. Post. Reply. Repeat. See you at $5k.
