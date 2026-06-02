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

| #   | Service                                                                                  | Why                               | Cost month 1        |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------- | ------------------- |
| 1   | **Hyperliquid mainnet account** (this is your **treasury** — receives builder-code fees) | Required to register builder code | ~$2 gas             |
| 2   | **Hyperliquid testnet account**                                                          | Smoke testing                     | free                |
| 3   | **AWS account** (us-east-1 region)                                                       | KMS for sealing agent keys        | <$5                 |
| 4   | **Neon** (or Supabase/RDS) — Postgres 15+                                                | App DB                            | $0–$19              |
| 5   | **Upstash Redis** — global, eviction off                                                 | Streams + caches                  | $0–$10              |
| 6   | **Render / Fly.io / Railway** — Node 22 runtime                                          | Host the bot process              | $7–$25              |
| 7   | **Vercel**                                                                               | Host the mini-app (WebApp)        | $0                  |
| 8   | **Cloudflare**                                                                           | DNS + (optional) WAF for mini-app | $0                  |
| 9   | **Telegram account** + a throwaway dev account for testing                               | Bot ops                           | $0                  |
| 10  | **X (Twitter)** brand account `@whalepod` (or your name)                                 | Marketing                         | $0 (or $8 for blue) |
| 11  | **Discord** (optional — most users don't want it; TG group is enough)                    | Support                           | $0                  |
| 12  | **Domain** — `whalepod.trade` (or your pick)                                             | Mini-app + landing                | ~$15/yr             |
| 13  | **PostHog** or **Plausible** (analytics)                                                 | Funnel tracking                   | $0                  |
| 14  | **Sentry** (error tracking)                                                              | Crash visibility                  | $0                  |
| 15  | **GitHub**                                                                               | Source + Actions for CI           | $0                  |

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
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:us-east-1:<acct>:key/<KeyId>"
    }
  ]
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
   - Short name: `whalepod` → this builds `t.me/whalepod_bot/whalepod`.

### 4.2 Bot Menu Button

`/setmenubutton` → "Open WhalePod" → URL `https://app.whalepod.trade`.

### 4.3 Group (do this on day T-3, see §11)

- Create `@whalepodchat` public group.
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

### 7.1 Railway (bot + ws-consumer)

1. Connect GitHub repo `Tonyflam/U` to your Railway project.
2. Create service **whalepod-bot**:
   - Root: repo root.
   - Runtime: Node 22 (set `engines.node` or `NIXPACKS_NODE_VERSION=22`).
   - Build: `npm ci && npm run build -w packages/schema && npm run build -w packages/sdk && npm run build -w packages/config && npm run build -w packages/vault && npm run build -w apps/bot`
   - Start: `node apps/bot/dist/start.js`
   - Health check path: `/healthz` (fastify returns 200).
   - Region: closest to Upstash + Neon (us-east).
   - Auto-deploy: ON for `main`.
3. Create service **whalepod-ws** (same repo):
   - Build: `npm ci && npm run build -w packages/schema && npm run build -w packages/sdk && npm run build -w apps/ws-consumer`
   - Start: `node apps/ws-consumer/dist/start.js`
   - No public port; no health check.
4. Paste env vars (both services) from §5.1 with mainnet values:
   - `HL_NETWORK=mainnet`
   - `HL_API_URL=https://api.hyperliquid.xyz`
   - `HL_WS_URL=wss://api.hyperliquid.xyz/ws`
   - `BUILDER_ADDRESS=0x1CD2B147EfE092c3BdE0B474bCE3Bd33ae3dbB37`
   - `DATABASE_URL=…neon mainnet…`
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (bot only)
   - `BOT_MODE=webhook` (bot only)
   - `SHARE_TOKEN_SECRET`, `MIRROR_VAULT_KEY`, `SENTRY_DSN`
   - Optional safety: `MIRROR_USER_ALLOWLIST=<csv of user.id UUIDs>` to gate mirroring to specific users. Leave unset to allow all.
5. Generate a public domain for **whalepod-bot** (Settings → Networking → Generate Domain).
6. Set the Telegram webhook:
   ```bash
   curl -F "url=https://<railway-bot-domain>/tg/webhook" \
        -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
        https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook
   ```
7. Verify:
   ```bash
   curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo
   ```
   `pending_update_count` should be 0 and `last_error_date` should be null.

### 7.2 Vercel (mini-app)

Already live at `app.whalepod.trade`. Confirm env vars match the bot:

- `NEXT_PUBLIC_HL_NETWORK=mainnet`
- `NEXT_PUBLIC_BUILDER_ADDRESS=0x1CD2B147EfE092c3BdE0B474bCE3Bd33ae3dbB37`
- `SHARE_TOKEN_SECRET` (must match the bot exactly — HMAC for short-link tokens)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (must match the bot — short-link store is shared)

After updating envs in Vercel, redeploy.

### 7.3 First-canary

Onboard yourself first via `/start` on @whalepod_bot. Connect a real wallet with **$200 max-size** subscription. Follow one well-known active whale. Let it run for 2 hours. Tail Railway logs and watch the HL builder dashboard for fee accrual.

If 2 hours pass with mirrored fills + zero errors + fees showing up → remove `MIRROR_USER_ALLOWLIST` from Railway and redeploy to open up to the public.

---

## 8. Day-0 sanity checks

Run all of these within 1 hour of going live. Save the screenshots — you'll post them.

| #   | Check             | How                                                                     | Pass criteria                                    |
| --- | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | DB writes         | `SELECT count(*) FROM users` after you onboard                          | ≥1                                               |
| 2   | Agent key sealed  | `SELECT octet_length(agent_key_ct) FROM users LIMIT 1`                  | >0                                               |
| 3   | Audit log         | `SELECT action FROM audit_log ORDER BY id DESC LIMIT 5`                 | shows `onboard`, `subscribe`, `mirror_submitted` |
| 4   | Fills row written | `SELECT * FROM fills WHERE is_mirror=true LIMIT 1` (after first mirror) | 1 row, `realized_pnl_usd` NULL until close       |
| 5   | Builder fee in HL | HL UI → builder dashboard for your treasury                             | shows your fill                                  |
| 6   | TG push received  | The bot DM'd you the fill                                               | yes                                              |
| 7   | `/pnl`            | run command                                                             | renders without error                            |
| 8   | `/leaderboard`    | run command                                                             | shows you (entry of 1 is fine)                   |
| 9   | Mute path         | `/notify off`, force a mirror, no DM arrives                            | yes                                              |
| 10  | Kill switch       | `/kill`, force a whale fill, **no mirror** placed                       | confirm in HL                                    |
| 11  | Geo block         | (optional) curl onboarding endpoint via a blocked-country VPN           | gets refused                                     |
| 12  | Sentry            | force an error, confirm it lands                                        | yes                                              |

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

> **The math.** $5,000 fees / 0.0005 = **$10M of mirrored notional in 30 days = ~$333k/day**.
>
> Two ways to get there:
>
> | Path         | Active users | Avg mirrored / user / day | Comment                                   |
> | ------------ | ------------ | ------------------------- | ----------------------------------------- |
> | Many small   | 120          | $2,800                    | Hardest — needs viral growth              |
> | Fewer larger | 40           | $8,500                    | Easier — one whale + 40 serious followers |
>
> **Bet on the second path.** One mid-tier whale endorsement (someone running $50k+ with 20 onlookers) replaces a week of cold posting. Optimise everything below for **whale outreach + HL ecosystem visibility**, not generic crypto Twitter.
>
> Public X handle: **@whalepodapp**. Bot: **@whalepod_bot**. TG group (to create Day 0): **@whalepodchat**.

### 10.1 Channels in order of leverage

1. **Direct whale DMs** — highest ROI per minute. (§10.4.) One yes = a week of distribution.
2. **Hyperliquid Discord `#builder-codes` / ecosystem channels** — high-intent, low-noise.
3. **Hyperliquid team retweet** — tag `@HyperliquidX` + `@chameleon_jeff` only when you have something genuinely worth their RT (a real metric, a clean demo).
4. **Quote-tweets of whale wins** — every time a mirrored whale closes a notable trade, reply / QRT with "N WhalePod followers auto-mirrored. Avg follower P&L: $X."
5. **Referral program** — `/share` mints a code. Pay top 3 in cash at month end (§10.6).
6. **Micro-KOLs (5k–30k followers, perp-focused)** — offer them a manual affiliate split.
7. **Paid ads** — _skip in month 1._ Don't pay for traffic until onboarding-to-first-fill conversion is >70%.

### 10.2 X (Twitter) cadence

- **Pre-launch (T-7 → T-1)**: 1 build-in-public post/day. Show screenshots, talk about your fee model, post your whale picks. (Templates in [Appendix A.1](#a1-pre-launch-x-posts).)
- **Launch day (T-0)**: 1 hero post pinned. Quote-RT it from a co-builder account if you have one.
- **Week 1**: 2 posts/day. One product (a new feature, a screenshot of /leaderboard), one community (RT a user's win, "we mirrored 27 trades today").
- **Week 2–4**: 1 post/day minimum + reply to every HL ecosystem post that's relevant.

### 10.3 Telegram cadence

- **Post in your own group**: 1 update/day minimum. New whales, fee numbers, fixes shipped.
- **Cross-post in Hyperliquid TG / chat groups**: only when it's _useful_ (a new whale you added, a feature). Spamming = ban.

### 10.4 Reach out to whales personally (DM)

This is unglamorous, high-ROI work. For the 10 whales you seed:

- Find their TG/X via on-chain detective work (HL leaderboard sometimes links).
- Send a short DM: _"Hi. We built a tool that lets people mirror your trades on HL. We don't take a cut from you; users pay a 5 bps fee on their own fills. ~30 mirror followers so far. If you tweet/post about us, we'll send the first 100 referrals to your bag (or a payout) — happy to discuss."_

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

| Platform                  | Fee                           | Custody                  |
| ------------------------- | ----------------------------- | ------------------------ |
| Centralized copy-trader X | 20% of profits                | They hold                |
| Hyperliquid + manual copy | gas + slip + your time        | You                      |
| **WhalePod**              | **5 bps (0.05%) of notional** | **You (agent key only)** |

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

## 11. Day-by-day launch schedule — the next 30 days

> **State at Day 0**: bot live at @whalepod_bot on Railway, ws-consumer running, miniapp at app.whalepod.trade, X account verified at @whalepodapp, DB clean (0 users), HL mainnet with builder address `0x1CD2…dbB37`, your own wallet seeded with $30. Tech is done — every line below is execution.
>
> **Cadence rule**: post twice a day on X (10:00 UTC + 18:00 UTC) and once in the TG group, every day. Skip nothing. Two missed days = the algo forgets you.
>
> Each "post" below is exactly what to ship. Replace `<…>` with real numbers. Track every metric in a Google Sheet daily (\u00a713 metrics).

---

### Day 0 — TODAY (setup distribution surface)

**Morning (do these first, in order, ~90 min):**

1. **Pick 10 seed whales** from https://hypurrscan.io/leaderboard (30d window, sort by realized PnL). Criteria: actively trading last 7d, win rate >55%, trades majors (BTC/ETH/SOL), 1\u20135\u00d7 leverage. Save the 10 addresses + their stats to a sheet.
2. **Insert them into the DB** as featured whales (\u00a79.2 has the SQL).
3. **Create `@whalepodchat` TG public group**: pin the welcome message (A.7.1), set slow-mode 5s, add yourself as admin.
4. **Record a 30-second screen-recording demo**: open @whalepod*bot \u2192 /start \u2192 connect wallet in miniapp \u2192 /follow `0x…` \u2192 push notification arrives \u2192 /pnl. **This single asset is the highest-leverage thing you'll make all month.** Save as `demo.mp4` (under 15MB for X) and `demo.gif` (under 5MB).\n5. **Pin profile setup on @whalepodapp**: bio \u2192 `Copy-trade Hyperliquid whales from Telegram. 5 bps. Non-custodial. \u2192 t.me/whalepod_bot`. Pinned tweet \u2192 the launch thread you'll post at noon.\n6. **Fund your HL wallet with $30** and onboard yourself via @whalepod_bot. Follow 1 whale, max-size $10, leverage 1\u00d7. Confirm one mirror lands today.\n\n**12:00 UTC \u2014 X post (LAUNCH THREAD, pin it):**\n\n> 1/ WhalePod is live on @HyperliquidX mainnet. \ud83d\udc33\n>\n> Copy-trade the top HL whales from inside Telegram. Open the bot, connect your wallet, /follow 0x\u2026, every trade they make you make (sized to your equity).\n>\n> 5 bps. Non-custodial. No subscription.\n>\n> Demo \ud83d\udc47\n> [attach demo.mp4]\n\n> 2/ Non-custodial. You sign once to authorize an agent wallet \u2014 fee-capped, no withdraw permission. Revoke any time on https://app.hyperliquid.xyz. Your keys never leave your wallet.\n\n> 3/ 5 bps (0.05%) on your own fills via @HyperliquidX builder codes. No profit share. No \"performance fee.\" No monthly. HL caps builder fees at 10 bps; we default to half.\n\n> 4/ 10 whales hand-picked for launch. All profitable last 30d. All active this week. Browse with /leaderboard in the bot.\n\n> 5/ Risk controls in the box: `/kill` global stop, `/pause` per-account, `/tp` `/sl` per-whale, daily notional cap, equity floor, geofencing.\n\n> 6/ \ud83d\udc49 t.me/whalepod_bot\n> Built solo. No VCs. RTs save lives.\n\n**18:00 UTC \u2014 X post (single, replies on):**\n\n> Day 1 of WhalePod public.\n>\n> If you trade on @HyperliquidX and you want to copy a whale without writing code or trusting a vault, this is for you.\n>\n> Drop a \ud83d\udc33 if you onboarded today \u2014 I'll add you to the alpha group.\n>\n> t.me/whalepod_bot\n\n**Distribution after the noon post (within 1 hour):**\n- HL Discord \u2192 `#builder-codes` (and `#dev-showcase` if it exists): one message, the demo gif, one link. Don't @ anyone.\n- HL ecosystem TGs (e.g. https://t.me/hyperliquidcommunity if it exists): one polite intro + link.\n- DM 5 whales from your seed list (template \u00a710.4). Personalise the first line with their address's 30d PnL.\n- Reply to the 5 most recent posts on @HyperliquidX timeline with a thoughtful comment (no link \u2014 just be present).\n\n---\n\n### Day 1 — first stats post + whale outreach push\n\n- **10:00 UTC X post** (quote-RT yesterday's hero thread):\n > 24 hours since launch:\n > \u00b7 <N> users onboarded\n > \u00b7 <N> whales followed\n > \u00b7 <N> mirrors landed\n > \u00b7 $<X> in builder fees\n >\n > Day 2 plan: add 3 whales + ship faster /pnl.\n >\n > t.me/whalepod_bot\n\n- **18:00 UTC X post** (single, with screenshot of /pnl on your own account):\n > Your /pnl in WhalePod, live data from @HyperliquidX:\n >\n > [screenshot of your real /pnl reply]\n >\n > Net of builder fees. Realized + unrealized. Per whale. Updated every fill.\n\n- **DM 5 more whales** (different addresses today). Track \"contacted/replied/declined\" in your sheet.\n- **TG group post**: announce the referral program (Appendix A.3) so word starts spreading.\n- **Apply to Hyperliquid's builder-codes showcase** if there's an open form. Tweet at @chameleon_jeff once with the demo gif: *\"@chameleon*jeff hey \u2014 built a TG copy-trader on your builder codes. Live with real users. Would love it on the showcase if it fits.\"* One ask, then drop it.\n\n---\n\n### Day 2 — first community-driven post\n\n- **10:00 UTC X post** (use last night's whale fill):\n > Whale `0x\u2026<addr>` opened a long on $ETH at 02:14 UTC.\n  >\n  > <N> WhalePod followers auto-mirrored. Avg follower size: $<Y>. No screen-watching. No spreadsheet.\n  >\n  > /follow them in @whalepod_bot.\n\n- **18:00 UTC X post** (educational, no link):\n  > Why builder codes > vaults for copy-trading:\n  >\n  > \u2022 You hold your own funds. The agent wallet can trade but never withdraw.\n  > \u2022 Fee is on notional (5 bps) not profit (20%+ on most vaults).\n  > \u2022 No lockup. Revoke the agent any time.\n  >\n  > That's it. That's the pitch.\n\n- **DM 5 more whales.** Total this week: 15.\n- **Reply** to every comment on yesterday's posts. Aim <15 min response time during US/EU waking hours.\n\n---\n\n### Day 3 — first trade replay (this is your best converting format)\n\n- **10:00 UTC X post** (trade replay, Appendix A.6 template):\n  > @<alias> just closed +$<X> on $<COIN>.\n  >\n  > Entry: $<E>\n  > Exit: $<X>\n  > Hold: <H>h\n  >\n  > <N> WhalePod followers auto-mirrored. Avg follower P&L: +$<Y>. Fee paid: $<Z> (5 bps).\n  >\n  > /follow 0x\u2026<addr> in @whalepod_bot.\n\n- **18:00 UTC X post** (short, founder voice):\n  > 3 days in:\n  > \u2022 <N> users\n  > \u2022 $<X> fees\n  > \u2022 0 incidents\n  >\n  > Slow. Steady. The boring infra play.\n\n- **TG group**: post a screenshot of today's /pnl from one (consenting) user, blurred wallet.\n\n---\n\n### Day 4 — push for first whale endorsement\n\n- **10:00 UTC X post** (tag whales who haven't replied to your DMs):\n  > Top 5 @HyperliquidX whales we're mirroring this week:\n  >\n  > 1. `0x\u2026a` \u2014 +<X>% 30d, mostly ETH\n  > 2. `0x\u2026b` \u2014 +<Y>%\n  > 3. `0x\u2026c` \u2014 +<Z>%\n  > 4. `0x\u2026d`\n  > 5. `0x\u2026e`\n  >\n  > Mirror any of them in 2 taps \u2192 @whalepod_bot.\n\n- **18:00 UTC X post**: quote-RT any HL ecosystem account that mentioned you. If none, post:\n  > Onboarding flow in WhalePod: open TG \u2192 /start \u2192 tap the button \u2192 sign one approve in your wallet \u2192 done. <30s from zero to mirroring.\n  >\n  > [attach demo.gif]\n\n- **DM 5 more whales.** Week 1 total: 25.\n- **Add 2 new whales** to the seed set based on the leaderboard movers.\n\n---\n\n### Day 5 — first paid referral teaser\n\n- **10:00 UTC X post**:\n  > Referral leaderboard for WhalePod week 1:\n  >\n  > 1st place: $200 USDC\n  > 2nd: $100\n  > 3rd: $50\n  >\n  > Paid manually at end of week from builder fees. /share in @whalepod_bot to get your code.\n\n- **18:00 UTC X post** (community proof):\n  > One of our users went from `/start` to mirroring a whale fill in 41 seconds today.\n  >\n  > That's the bar. Anything slower is on us.\n\n- **TG group**: pin the referral leaderboard message; update daily.\n\n---\n\n### Day 6 — KOL outreach + retention\n\n- **10:00 UTC X post**:\n  > 5 days of WhalePod stats:\n  > \u00b7 <N> users\n  > \u00b7 $<X>m mirrored notional\n  > \u00b7 $<Y> builder fees\n  > \u00b7 <Z> active whales\n  > \u00b7 0 downtime\n  >\n  > [chart screenshot if you have one]\n\n- **18:00 UTC X post** (transparency):\n  > Things shipped this week:\n  > \u2022 Mainnet launch on @HyperliquidX\n  > \u2022 Push notification <3s latency\n  > \u2022 /pnl net-of-fees\n  > \u2022 /leaderboard for whale browsing\n  > \u2022 Trade-replay share cards\n  >\n  > Things shipping next week:\n  > \u2022 <one promise you can keep>\n\n- **DM 5 micro-KOLs** (5k\u201330k followers, perp-trading focused). Template:\n  > \"Hi. Built WhalePod \u2014 TG bot for copy-trading HL whales, live with <N> users on mainnet. Open to a manual affiliate split if you'd like to try it; I'll cover the first $X of your followers' fees. Demo: [link]. No pressure.\"\n\n---\n\n### Day 7 — first weekly transparency post\n\n- **10:00 UTC X post (THREAD)** \u2014 use Appendix A.4.2 exactly:\n  > WhalePod week 1:\n  > \u00b7 Active users: <N>\n  > \u00b7 Mirrored notional: $<X.XX>m\n  > \u00b7 Builder fees: $<Y>\n  > \u00b7 Top whale (user P&L): @<alias> (+$<Z>)\n > \u00b7 Avg push latency: <X>s\n >\n > Coming this week: <one thing>.\n\n- **End of Day 7 reality check**:\n - **Target**: 25\u201340 users, $400k\u2013$800k mirrored notional, **$200\u2013$400 fees**.\n  - If you're at <10 users: the demo isn't landing. **Re-record the demo video**, make it tighter (15s, no audio, one whale fill).\n  - If you're at >40: double down on whale outreach \u2014 you have product-market fit signal.\n\n---\n\n### Day 8\u201314 — compounding week\n\nDaily template (every day, 09:00\u201320:00 UTC):\n\n| Slot | Action |\n| --- | --- |\n| 09:00 | Pull DB metrics (\u00a712.2 SQL). Update sheet. Look at Sentry. |\n| 10:00 UTC | **X post 1** \u2014 yesterday's stats or new whale (A.5) |\n| 12:00 UTC | TG group post (replay, win, or fix shipped) |\n| 14:00 | Reply to every DM / comment / mention. <15 min response. |\n| 16:00 | DM 3 new whales OR 3 KOLs |\n| 18:00 UTC | **X post 2** \u2014 trade replay (A.6) or educational thread |\n| 20:00 | Ship one tiny visible improvement (one whale added, one bug fixed, one copy tweak) \u2014 post about it. |\n\n**Day 8** \u2014 X post: \"What I learned from 50 mirror fills this week\" (educational thread, 4 tweets).\n\n**Day 9** \u2014 X post: feature comparison vs. centralised copy-traders (table format, Appendix \u00a710.7.A as image).\n\n**Day 10** \u2014 X post: tag @HyperliquidX with the week-1 fees screenshot and a thank-you. Often gets RT'd.\n\n**Day 11** \u2014 X post: quote-RT the biggest whale win of the week. Same format as Day 3.\n\n**Day 12** \u2014 X post: a user's testimonial (with their permission) \u2014 \"I never used a copy-trader before. Took me 30s.\"\n\n**Day 13** \u2014 X post: behind-the-scenes \u2014 \"How we set the 5 bps fee\" (educational, builds trust).\n\n**Day 14 (week 2 transparency post)** \u2014 same A.4.2 template. **Target by EOD**: 60\u201380 users, $2\u2013$3m notional, **$1k\u2013$1.5k fees** cumulative.\n\n**Mid-week 2 event**: run the **week-1 referral payout** publicly. Tweet the top 3 referrers' handles, USDC tx hashes on Arbitrum/HL of the payouts. Builds enormous trust.\n\n---\n\n### Day 15\u201321 — distribution amplification\n\n**Goal of week 3**: turn the existing user base into a referral engine + land one HL team retweet OR one whale endorsement.\n\n- **Day 15**: launch a **\"copy-trade challenge\"** \u2014 anyone who mirrors $5k+ notional via @whalepod_bot in week 3 enters a raffle for $200 USDC. Tweet + pin in TG.\n- **Day 16**: drop a **leaderboard of users** (anonymised: \"User #42 \u2192 +$X net P&L this week\"). Social proof.\n- **Day 17**: write a **long-form X thread** (8\u201310 tweets) \u2014 \"30 days of building a Telegram bot that prints from HL builder fees.\" Numbers, lessons, screenshots. This is the post that catches a bigger account's eye.\n- **Day 18**: reach out to 5 more KOLs. Different list. Offer affiliate split: 25% of the fees their referees generate for 90 days, paid manually.\n- **Day 19**: post a **whale-of-the-week** spotlight \u2014 one whale, one chart, one CTA.\n- **Day 20**: ship a small but visible feature (e.g. `/whales` sorted by 7d PnL) and post about it.\n- **Day 21 (week 3 transparency post)** \u2014 A.4.2 template. **Target**: 90\u2013120 users, $5\u2013$7m notional, **$2.5k\u2013$3.5k fees** cumulative.\n\n---\n\n### Day 22\u201330 — closing kick\n\n**Goal of week 4**: clear $5k cumulative + set up month 2.\n\n- **Day 22**: **giveaway** \u2014 \"RT + drop your /share link \u2192 3\u00d7 $100 USDC randomly drawn Day 28.\" One tweet. Pin it.\n- **Day 23**: trade replay (A.6). Tag the whale's alias.\n- **Day 24**: post a **revenue-share update** \u2014 \"WhalePod has paid $X back to referrers this month.\" Transparency loop.\n- **Day 25**: reach out to 1 podcast / newsletter (e.g. _The Daily Gwei_, _Bankless TG groups_, _Hyperliquid-focused newsletters_). One ask each.\n- **Day 26**: post **week 4 stats so far** + cliffhanger: \"If we hit $5k by Sunday we ship <next feature>.\"\n- **Day 27**: trade replay or new whale post.\n- **Day 28**: **announce raffle winners** publicly with USDC tx hashes. Builds permission to do this monthly.\n- **Day 29**: **founder reflection post** \u2014 \"30 days of WhalePod: <users>, <notional>, <fees>, <lessons>.\" Honest. Specific.\n- **Day 30 (month-1 transparency thread)** \u2014 4\u20136 tweets, all numbers, no fluff. **Target**: 120+ users, $10m+ notional, **$5k+ fees**. Tag @HyperliquidX and @chameleon_jeff in the last tweet (\"thanks for the rails\").\n\n---\n\n### If you're behind plan at Day 14\n\nDiagnosis tree:\n\n| Symptom | Cause | Fix |\n| --- | --- | --- |\n| <20 users | Demo isn't converting | Re-record demo: 15s, no audio, one whale fill landing |\n| 30+ users, <$500 fees | Users mirror too small | Add a \"recommended size\" tooltip in onboarding; raise default to $50 |\n| Lots of /start, no /follow | Onboarding friction | Look at Sentry + miniapp logs; fix the broken step |\n| Big spikes then silence | One viral post, no follow-through | You're not posting daily \u2014 fix the cadence |\n| Whales not replying | DM template is too long | Shorten to 2 sentences; lead with their P&L number |\n\n### If you're ahead of plan at Day 14\n\n- **Raise the daily notional cap** in Railway env (`RISK_MAX_DAILY_NOTIONAL_USD`) so bigger users aren't throttled.\n- **Add 5 more whales** \u2014 supply is now the bottleneck.\n- **Reply faster.** At 100+ users, response time becomes the brand.\n- **Start writing the month-2 feature** (position-based mirror, \u00a716) so you have something to announce Day 30.

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

| Metric                                 | Target end of month 1 | Why                              |
| -------------------------------------- | --------------------- | -------------------------------- |
| Active users                           | 120                   | Direct revenue driver            |
| Active subscriptions / user            | 2.0                   | Diversification = retention      |
| Mirrored notional / day                | $333k                 | Math to $5k                      |
| Builder fees earned / day              | $167                  | Same                             |
| **Builder fees earned, month total**   | **$5,000**            | The goal                         |
| Onboarding completion rate             | >70%                  | Otherwise marketing wastes spend |
| Day-7 retention                        | >50%                  | Otherwise the funnel leaks       |
| Day-30 retention                       | >35%                  | Otherwise no compounding         |
| Push notification delivery latency p95 | <5s                   | UX feel                          |
| Mirror submission latency p95          | <3s                   | Catch the price                  |
| /pnl renders without error             | 100%                  | Trust                            |
| Errors per 1000 mirror attempts        | <5                    | Engineering health               |

Set up a Looker/Metabase dashboard against the read replica.

---

## 14. Incident response

### 14.1 Severity levels

| Sev                    | Example                              | Response time            |
| ---------------------- | ------------------------------------ | ------------------------ |
| **S0 — funds at risk** | KMS key disclosed, agent keys leaked | **immediate** — see 14.2 |
| **S1 — trading down**  | Bot crashing, no mirrors landing     | <15 min                  |
| **S2 — degraded**      | High latency, push delays            | <2h                      |
| **S3 — cosmetic**      | /pnl off-by-1                        | next day                 |

### 14.2 S0 runbook (memorize this)

1. **Toggle global kill**: set env `GLOBAL_KILL=true`, redeploy. The bot will refuse all `submitMirror` calls.
2. **Revoke the KMS key** in AWS console (disables decryption of every agent key).
3. **Post in TG group**: "We've detected a security incident. We've paused all mirroring as a precaution. No funds can be withdrawn by the bot. You're safe. Updates here as we know more."
4. Forensics: pull the audit log. `audit_log` is append-only; the last writes will tell you what happened.
5. Rotate the KEK (create new key in §2.1, re-encrypt every `agent_dek_ct` via a backfill script, swap alias).

### 14.3 S1 runbook

1. Tail Railway logs (`whalepod-bot` and `whalepod-ws` services). Look for the first ERROR.
2. Check upstream: Hyperliquid status, Upstash status, Neon status, Telegram status (https://core.telegram.org/api/status).
3. If HL is down: post in TG "HL is down, we're paused with them. Will resume automatically."
4. If our bug: roll back the last deploy in Railway (Deployments tab → click the previous green deploy → **Redeploy**) while you fix forward.

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

In **every** TG message, X post, and mini-app screen, avoid words like _"guaranteed,"_ _"risk-free,"_ _"will moon,"_ _"sure thing."_ Stick to factual past performance ("whale X is up Y% over 30d on HL").

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

#### A.1.2 (Day 1: product screenshot)

> WhalePod /pnl, live on Hyperliquid mainnet 👇
>
> [image of /pnl reply]
>
> Realized + unrealized broken out per whale. Net of builder fees. Synced from your real HL fills. No spreadsheet.

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

> 6/ Open in TG → [t.me/whalepod_bot]
> Docs → [whalepod.trade]
> Source → [github link]
>
> Built in N days. No VCs. RTs welcome.

### A.3 Referral launch

#### A.3.1

> Referral program for week 1:
>
> Use `/share` in @whalepod_bot to get your invite link.
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
> Mirror in 2 taps → /follow 0x...abcd in @whalepod_bot

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
> No spreadsheet. No screen-watching. /follow 0x... in @whalepod_bot.

### A.7 Telegram group templates

#### A.7.1 (group welcome — pinned)

> 👋 Welcome to WhalePod.
>
> · Copy-trade HL whales. 5 bps. Non-custodial.
> · Open the bot → @whalepod_bot → /start
> · Commands: /help
> · Support: tag an admin
> · Bug? DM @<your_handle> with a screenshot.
>
> Rules:
>
> 1. No shilling other tools / projects.
> 2. No financial advice. We post stats, not predictions.
> 3. Be civil. One warning, then ban.

#### A.7.2 (whenever a whale you mirror posts publicly)

> 🚨 Whale @<alias> just posted about their HL setup → [link]
>
> If you mirror them via WhalePod, you'll auto-follow whatever they do next. /follow 0x... in @whalepod_bot.

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
