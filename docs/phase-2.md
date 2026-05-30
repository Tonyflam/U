# WhalePod — Phase 2: Technical Architecture & Security Plan

> **Status:** Phase 1 confirmed. Domain `whalepod.trade` bought. TG bot `@whalepod_bot` reserved.
> This document gates Phase 3 (code). Nothing in Phase 3 ships unless the relevant section here is satisfied.

---

## 1. System Architecture

### 1.1 Component diagram

```
                                ┌─────────────────────────────────────────┐
                                │              USER PHONE                 │
                                │                                         │
                                │   ┌──────────────┐   ┌──────────────┐   │
                                │   │ Telegram app │   │ Wallet app   │   │
                                │   │              │   │ (Rabby/MM)   │   │
                                │   └──────┬───────┘   └──────┬───────┘   │
                                └──────────┼──────────────────┼───────────┘
                                           │ TG Bot API       │ EIP-712 sig
                                           │ (HTTPS)          │ (in browser)
                                           ▼                  ▼
              ┌────────────────────────────────────┐    ┌─────────────────────────┐
              │       Fly.io: bot-edge VM          │    │  Vercel: miniapp        │
              │  ┌──────────────────────────────┐  │    │  (Next.js, edge)        │
              │  │  TG Bot (grammy)             │  │    │                         │
              │  │  - webhook handler           │  │    │  - approveAgent UI      │
              │  │  - command router            │  │    │  - approveBuilderFee UI │
              │  │  - per-user rate limit       │  │    │  - replay-protected     │
              │  │  - abuse guard               │  │    │    nonce service        │
              │  └────────────┬─────────────────┘  │    └──────────┬──────────────┘
              │               │                    │               │
              │               ▼                    │               │ POST signed
              │  ┌──────────────────────────────┐  │               │ approval
              │  │  Order Router                │  │◀──────────────┘
              │  │  - validates intent          │  │
              │  │  - clamps to user limits     │  │
              │  │  - constructs HL action      │  │
              │  │  - signs with agent key      │  │
              │  │  - posts to HL exchange      │  │
              │  └────────┬───────────┬─────────┘  │
              │           │           │            │
              │           ▼           ▼            │
              │  ┌─────────────┐  ┌──────────────┐ │
              │  │ Vault Svc   │  │ HL SDK       │ │
              │  │ (in-proc)   │  │ wrapper      │ │
              │  │ - KMS decrypt│ │ (@nktkas)    │ │
              │  │ - zeroize   │  │              │ │
              │  └──────┬──────┘  └──────┬───────┘ │
              └─────────┼────────────────┼─────────┘
                        │                │
                        │                │ HTTPS
                        ▼                ▼
              ┌─────────────────┐  ┌────────────────────┐
              │   AWS KMS       │  │ Hyperliquid API    │
              │  (encrypt /     │  │ /exchange (REST)   │
              │   decrypt only) │  │ /info  (REST)      │
              └─────────────────┘  └────────────────────┘

              ┌────────────────────────────────────┐
              │       Fly.io: ws-consumer VM       │
              │  ┌──────────────────────────────┐  │
              │  │ HL WebSocket pool (1 conn)   │  │      wss://api.hyperliquid.xyz/ws
              │  │ - userFills (per tracked)    │◀─┼─────────────────────────────────
              │  │ - allMids                    │  │
              │  │ - reconnect + backfill       │  │
              │  └────────────┬─────────────────┘  │
              │               │                    │
              │               ▼                    │
              │  ┌──────────────────────────────┐  │
              │  │ Mirror Engine                │  │
              │  │ - whale fill received        │  │
              │  │ - resolve subscribers        │  │
              │  │ - size normalize             │  │
              │  │ - emit MirrorIntent          │  │
              │  └──────────────┬───────────────┘  │
              └─────────────────┼──────────────────┘
                                │
                                │ Redis stream
                                ▼
              ┌────────────────────────────────────┐
              │       Upstash Redis                │
              │  - mirror-intents stream           │
              │  - rate-limit token buckets        │
              │  - dedupe (idempotency keys)       │
              │  - session locks                   │
              └─────────────────┬──────────────────┘
                                │
                                ▼ (consumed by Order Router on bot-edge)

              ┌────────────────────────────────────┐      ┌──────────────────────┐
              │       Supabase Postgres            │      │ Vercel: web + admin  │
              │  - users, agents (enc), whales,    │      │ - landing            │
              │    subscriptions, fills, settings, │      │ - admin dashboard    │
              │    referrals, rate_buckets, audit  │      │   (cookie + IP allow)│
              └────────────────────────────────────┘      └──────────────────────┘

              ┌────────────────────────────────────┐
              │       Cloudflare                   │
              │  - DNS, WAF, Email Routing         │
              │  - rate-limit at edge              │
              └────────────────────────────────────┘
```

### 1.2 Trust boundaries

| #   | Boundary                   | Direction           | Trust                                                                              |
| --- | -------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| B1  | User phone ↔ Telegram     | both                | TG-mediated, encrypted in transit. TG sees plaintext.                              |
| B2  | TG ↔ bot-edge             | inbound webhook     | Authenticated via secret token in TG webhook URL; verify on every request.         |
| B3  | User wallet ↔ miniapp     | both                | Browser-only signing. Miniapp never sees private key.                              |
| B4  | Miniapp ↔ bot-edge        | outbound POST       | Authenticated by signed payload (EIP-712) + miniapp-server JWT.                    |
| B5  | bot-edge ↔ KMS            | outbound            | IAM role, least-privilege (Decrypt only).                                          |
| B6  | bot-edge ↔ Hyperliquid    | outbound            | TLS. Hyperliquid is the ultimate authority on what actions agent keys can perform. |
| B7  | ws-consumer ↔ Hyperliquid | outbound            | TLS, read-only subscriptions.                                                      |
| B8  | bot-edge ↔ ws-consumer    | indirect, via Redis | mTLS or Upstash-issued token; no direct socket.                                    |
| B9  | Services ↔ Postgres       | outbound            | TLS, row-level security on user_id where applicable.                               |
| B10 | Admin dashboard ↔ users   | n/a                 | Internal only. Cookie auth + Cloudflare Access (IP allow / hardware-key).          |

**Critical invariant:** the only component that ever holds plaintext agent keys is the **in-process Vault Service inside the Order Router**, for the duration of one order signing operation (~10ms). Agent keys exist in DB only as KMS-envelope-encrypted ciphertext.

### 1.3 Data flow — happy path "whale opens position"

1. ws-consumer receives `userFills` event for a tracked whale wallet.
2. Mirror Engine queries Postgres: list of subscribers to this whale + their settings (max_size, leverage_cap, equity_floor, kill_switch_user).
3. For each eligible subscriber, emits one `MirrorIntent` to Redis stream `mirror-intents`, with idempotency key `{whale_fill_id}:{subscriber_id}`.
4. Order Router (on bot-edge) consumes stream, for each intent:
   a. Re-checks user is still eligible (settings may have changed).
   b. Clamps order size against max_size, leverage_cap, equity_floor.
   c. Asks Vault Service to decrypt agent key.
   d. Constructs HL `order` action with `builder={"b": <our_addr>, "f": <user_fee_int>}`.
   e. Signs via `@nktkas/hyperliquid`'s `sign_l1_action` equivalent.
   f. POSTs to `/exchange`.
   g. Zeroizes plaintext key in memory.
   h. Persists fill row in Postgres with `mirror_of=<whale_fill_id>`.
5. ws-consumer also receives the subscriber's own `userFills` for this mirrored order, marks the DB fill as confirmed.
6. TG Bot sends notification to user: "🔵 LONG ETH 10x @ $3,412 — mirrored from 0xWHALE". (✅ system status emoji allowed by voice rules.)

---

## 2. Stack Lock-In

### 2.1 Languages & runtimes

| Layer                           | Choice             | Pinned version                                  | Justification                                                                                                          |
| ------------------------------- | ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| All services                    | TypeScript         | 5.4.5 (strict mode, `noUncheckedIndexedAccess`) | Single language across bot/miniapp/router/admin/sdk = single ops surface for a solo founder. Type-safe RPC end-to-end. |
| Runtime (bot-edge, ws-consumer) | Node.js LTS        | 22.x                                            | Native fetch, native WebSocket, mature ecosystem, supported by Fly.io machine images.                                  |
| Runtime (miniapp, web, admin)   | Vercel Edge / Node | (Vercel-managed)                                | Cold-start latency for miniapp matters.                                                                                |

**Rejected:** Bun (immature in production WS reconnect handling), Deno (smaller ecosystem for grammy + viem), polyglot Rust for hot paths (premature; no benchmark says we need it). Reconsider Rust for ws-consumer at >5K DAU.

### 2.2 Libraries — pinned, justified

| Package                           | Version              | Purpose                       | Why this, not that                                                          |
| --------------------------------- | -------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `@nktkas/hyperliquid`             | `^0.32.2`            | HL SDK                        | Listed in HL docs as recommended TS SDK. Active maintenance. MIT.           |
| `viem`                            | `^2.21.0`            | EVM types, signing primitives | viem chosen over ethers v6 for tree-shake, types, and explicit EIP-712 API. |
| `grammy`                          | `^1.30.0`            | TG bot framework              | Mature, idiomatic TS, plugin ecosystem (rate-limit, sessions).              |
| `@grammyjs/runner`                | `^2.0.3`             | Webhook handler               | Required for webhook + concurrency.                                         |
| `@grammyjs/ratelimiter`           | `^1.2.0`             | Per-user rate-limit           | First-line abuse guard.                                                     |
| `next`                            | `15.x`               | Miniapp + landing + admin     | Vercel-native, edge-runtime support.                                        |
| `@telegram-apps/sdk-react`        | `^2.5.0`             | TG Mini-App SDK bindings      | Official-pattern, exposes `initData` for auth.                              |
| `zod`                             | `^3.23.8`            | Input validation              | Every external boundary validated.                                          |
| `drizzle-orm`                     | `^0.33.0`            | DB layer                      | Type-safe SQL, migration tooling, no Prisma runtime overhead.               |
| `postgres`                        | `^3.4.4`             | Postgres driver               | Lightweight, Drizzle-compatible.                                            |
| `@upstash/redis`                  | `^1.34.0`            | Redis client                  | HTTP-based, edge-compatible.                                                |
| `@upstash/ratelimit`              | `^2.0.3`             | Token bucket                  | IP + user-id rate limiting.                                                 |
| `satori` + `@vercel/og`           | `^0.10.x` + `^0.6.x` | PnL card renderer             | Server-side SVG/PNG generation. Fast, no headless Chrome.                   |
| `@aws-sdk/client-kms`             | `^3.658.0`           | KMS encrypt/decrypt           | Envelope encryption only.                                                   |
| `pino`                            | `^9.x`               | Logger                        | Fastest structured logger; we extend with redaction.                        |
| `@sentry/node` + `@sentry/nextjs` | `^8.x`               | Error tracking                | Standard. PII off.                                                          |
| `vitest`                          | `^2.1.x`             | Test runner                   | Fastest Vite-native, jest-compatible API.                                   |
| `fast-check`                      | `^3.x`               | Property tests                | Order-construction fuzzing.                                                 |
| `tsx`                             | `^4.19.x`            | Dev runner                    | No build step in dev.                                                       |
| `eslint` `@typescript-eslint/*`   | latest minor         | Lint                          | Standard.                                                                   |
| `prettier`                        | `^3.x`               | Format                        | Standard.                                                                   |
| `gitleaks` (pre-commit)           | latest               | Secret scan                   | Defense-in-depth before push protection.                                    |

**Supply-chain rules (binding):**

1. Lockfile committed (`package-lock.json`); CI fails on diff.
2. `npm ci --ignore-scripts` everywhere; `--ignore-scripts` is non-negotiable.
3. `npm audit signatures` in CI; failure blocks merge.
4. Dependabot weekly. Patch within 72h for any **high** advisory in a runtime dep; **critical** patched same-day or library quarantined.
5. **No new dep** added without (a) confirming GitHub Stars > 500 OR official org maintenance, (b) reading the lockfile diff, (c) noting it in `docs/deps.md` with one-sentence justification.
6. Production Docker base image pinned by **digest**, not tag: `node:22.11.0-alpine@sha256:<...>`.
7. No `postinstall` scripts in prod image.

---

## 3. Threat Model (STRIDE)

For each component, threats classified and mitigated. Highest-priority threats per the risk register are starred.

### 3.1 TG Bot (bot-edge)

| Threat                               | STRIDE | Mitigation                                                                                                                                                                                                                                |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **★ Webhook spoofing**               | S      | TG webhook URL contains 32-byte random secret token; webhook handler rejects any request without matching `X-Telegram-Bot-Api-Secret-Token` header. Token stored in KMS, rotated quarterly.                                               |
| **★ Bot token theft**                | S/E    | Token only in KMS. Loaded at boot, kept in process memory. Never logged, never in env files in prod. Rotation runbook in §8.                                                                                                              |
| User-ID spoofing within TG           | S      | All authenticated actions read `update.message.from.id` after webhook-secret check — TG attests identity. Cross-check on every sensitive action.                                                                                          |
| Command injection via message text   | T      | All user input parsed via zod schemas; no `eval`, no string-concat to shell, no template-string to SQL (Drizzle parameterized).                                                                                                           |
| Replay of TG messages                | T      | TG update_id deduped in Redis with 1h TTL.                                                                                                                                                                                                |
| Abuse via spam commands              | D      | grammy ratelimiter: 30 cmd/min per user. Upstash bucket: 10 order-placing intents/min/user.                                                                                                                                               |
| **★ Front-running by operator (us)** | T/E    | Order Router signs only with the user's agent key. We have **no own-account API on HL**. Code is AGPL-licensed and open-source. Order-construction logic property-tested for "intent in == order out" with no operator-controlled fields. |
| Privilege escalation between users   | E      | DB row-level access keyed by user_id, enforced in repository layer. No admin-impersonation path in code.                                                                                                                                  |
| Log leakage                          | I      | Pino redaction list (§4.3) drops every sensitive field before serialization.                                                                                                                                                              |

### 3.2 Miniapp (Vercel)

| Threat                       | STRIDE | Mitigation                                                                                                                                                                                                                                              |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **★ EIP-712 replay**         | T      | `nonce` = current ms timestamp; bot-edge rejects nonces seen in last 24h (Redis dedupe). `chainId` pinned to Arbitrum `0xa4b1` per HL spec. Domain separator pinned to `"HyperliquidSignTransaction"` v1. Mainnet/testnet flag from server, never user. |
| Phishing miniapp clone       | S      | TG-issued `initData` HMAC-verified server-side using bot token — only sessions launched from real `@whalepod_bot` accepted. Server-issued JWT (HS256, 5-min TTL) gates approval POSTs.                                                                  |
| XSS in approval flow         | T      | Next.js default CSP tightened: `default-src 'self'`; no inline scripts; no eval; React auto-escape. CSP report-only in dev → enforced in prod.                                                                                                          |
| Clickjacking                 | T      | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` everywhere except inside TG Mini-App context (TG-issued ancestor allowed via env-config).                                                                                                        |
| SSRF via user-controlled URL | T      | No user-supplied URLs fetched server-side anywhere in miniapp. Block by lint rule on `fetch(<dynamic>)`.                                                                                                                                                |
| Prototype pollution          | T      | zod parse strips unknowns; `Object.create(null)` for any user-data map.                                                                                                                                                                                 |
| Dependency confusion         | T      | Org-scoped packages where possible; package-lock-only installs.                                                                                                                                                                                         |

### 3.3 Order Router & Vault

| Threat                                           | STRIDE | Mitigation                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **★ Agent key compromise at rest**               | I      | Envelope encryption: AWS KMS master key encrypts per-user data keys; data keys encrypt agent keys (AES-256-GCM). Postgres stores only ciphertext + IV + KMS data-key ciphertext.                                                             |
| **★ Agent key compromise in memory**             | I      | Decrypted key held in a `Uint8Array`, used immediately, then `.fill(0)` zeroized in a `finally` block. Never written to disk or log. Per-request decrypt; no cache.                                                                          |
| **★ Unauthorized order placement**               | E      | Order Router is the only writer; gated by Redis-pulled intent. Intents are produced only by (a) Mirror Engine consuming HL WS, or (b) explicit user command from TG (with user-id check). Both paths verify user_id and active subscription. |
| Withdrawal abuse                                 | E      | Protocol-enforced (Q-4 verified). Defense-in-depth: code path for `withdraw3`/`usdSend`/`spotSend` is **physically absent** from Order Router. Lint rule + CI grep blocks introduction.                                                      |
| Order parameter tampering                        | T      | All HL action payloads built from typed intent objects; no string concatenation; clamp functions are pure and property-tested.                                                                                                               |
| Builder fee exceeding approval                   | T      | Fee `f` clamped to `min(user_approved_max_rate_int, default_5bps)` before signing. Property test asserts ∀ inputs `f ≤ approved`.                                                                                                            |
| Front-running between users via shared bot       | E/T    | Intents processed FIFO per stream partition, partitioned by user_id (Redis consumer group). One user's order cannot be delayed by another user's batch.                                                                                      |
| WebSocket disconnect drops fills (missed mirror) | D      | ws-consumer reconnects with exponential backoff; on reconnect, replays last 60s of `userFills` via REST `info` endpoint for each tracked whale. Idempotency keys dedupe.                                                                     |
| Replay of mirror intents on consumer restart     | T      | Redis stream consumer group + idempotency key in Postgres unique constraint `(whale_fill_id, subscriber_id)`.                                                                                                                                |

### 3.4 Database (Postgres)

| Threat                       | STRIDE | Mitigation                                                                                                                                                                                             |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQLi                         | T      | Drizzle parameterized queries. Zero string-concat SQL. ESLint rule banning `sql.raw` outside reviewed migration files.                                                                                 |
| Bulk PII exfil               | I      | No PII present. Worst-case: TG user IDs + wallet addresses + encrypted blobs. No emails, no IPs.                                                                                                       |
| Backup compromise            | I      | Supabase managed backups encrypted at rest. Daily logical dump exported to a separate region's encrypted bucket (B2 / R2), encrypted with `age` keypair whose private half is in offline cold storage. |
| Schema migration breaks prod | D      | Migrations applied via CI on a "shadow" DB first, then prod. All migrations forward-only; backfills are separate scripts.                                                                              |

### 3.5 Admin dashboard

| Threat              | STRIDE | Mitigation                                                                                                                                                                               |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized access | S/E    | Cloudflare Access in front (zero-trust, hardware-key required, IP allowlist). No public route to admin pages.                                                                            |
| Privilege misuse    | E      | Admin has **read** + **kill_switch_toggle**. No "place order on behalf of user" endpoint exists. Cannot be built without code review (you reviewing yourself the next day per DoD rule). |
| Audit gaps          | R      | Every admin action writes an `admin_audit` row: actor, action, target, before/after, timestamp.                                                                                          |

### 3.6 Cross-cutting (OWASP API Top-10 mapping)

| OWASP API risk                                       | Coverage                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| API1 Broken Object-Level Auth                        | All queries filtered by `user_id = currentUser.id`; tested.                |
| API2 Broken Authentication                           | TG-attested identity + miniapp HMAC + JWT (5min).                          |
| API3 Broken Object Property-Level Auth               | zod-typed responses; no `select *` to client.                              |
| API4 Unrestricted Resource Consumption               | Rate limits everywhere; per-user, per-IP, per-route.                       |
| API5 Broken Function-Level Auth                      | Admin routes behind Cloudflare Access; user routes check user_id.          |
| API6 Unrestricted Access to Sensitive Business Flows | Onboarding rate-limited; mirror-add rate-limited.                          |
| API7 SSRF                                            | No user-controlled outbound fetch. Lint-enforced.                          |
| API8 Security Misconfiguration                       | Configs in code, reviewed in PR. CSP enforced. CORS strict-origin per env. |
| API9 Improper Inventory Management                   | One `/openapi.json` style doc, internal only. No "v0 lying around".        |
| API10 Unsafe Consumption of 3rd-party APIs           | HL API responses validated against zod schemas before use.                 |

### 3.7 OWASP Top-10 (web) mapping

| Risk                          | Coverage                                                              |
| ----------------------------- | --------------------------------------------------------------------- |
| A01 Broken Access Control     | See API1/5.                                                           |
| A02 Cryptographic Failures    | KMS envelope; TLS 1.3; no DIY crypto.                                 |
| A03 Injection                 | zod + Drizzle parameterized.                                          |
| A04 Insecure Design           | This document.                                                        |
| A05 Security Misconfiguration | CSP, HSTS, secure cookies, no defaults.                               |
| A06 Vulnerable Components     | Lockfile + Dependabot + audit-signatures + CodeQL.                    |
| A07 Authentication Failures   | TG-attested + HMAC + JWT short-TTL.                                   |
| A08 Software & Data Integrity | Signed commits, signed npm where available, pinned base image digest. |
| A09 Logging Failures          | Pino with redaction, Sentry, Better Stack retention.                  |
| A10 SSRF                      | Lint rule + no user-controlled URLs.                                  |

---

## 4. Data Model

### 4.1 Schema (Postgres, Drizzle syntax)

```ts
// users
{
  id:                uuid PK default uuid_generate_v4(),
  tg_user_id:        bigint UNIQUE NOT NULL,
  tg_username:       text NULL,           // for support only; nullable; never user-facing as identity
  main_wallet:       text NOT NULL,       // 0x lowercased, checksum-validated on insert
  agent_address:     text NOT NULL,
  agent_key_ct:      bytea NOT NULL,      // AES-256-GCM ciphertext
  agent_key_iv:      bytea NOT NULL,      // 12 bytes
  agent_key_tag:     bytea NOT NULL,      // 16 bytes
  agent_dek_ct:      bytea NOT NULL,      // KMS-wrapped data encryption key
  approved_max_fee_tenths_bp: int NOT NULL, // e.g., 50 = 0.05% = 5 bps
  current_fee_tenths_bp: int NOT NULL DEFAULT 30, // 3 bps default
  equity_floor_usd:  numeric(18,2) NOT NULL DEFAULT 0,
  kill_switch:       bool NOT NULL DEFAULT false,
  geofence_country:  text NULL,
  created_at:        timestamptz NOT NULL DEFAULT now(),
  revoked_at:        timestamptz NULL,
  INDEX (tg_user_id),
  INDEX (main_wallet),
}

// whales (curated + user-added)
{
  id:                uuid PK,
  address:           text UNIQUE NOT NULL,  // lowercased
  alias:             text NULL,             // display name
  is_featured:       bool NOT NULL DEFAULT false,
  added_by:          uuid NULL REFERENCES users(id),
  last_fill_at:      timestamptz NULL,
  created_at:        timestamptz NOT NULL DEFAULT now(),
  INDEX (address), INDEX (is_featured, last_fill_at),
}

// subscriptions (user mirrors whale)
{
  id:                uuid PK,
  user_id:           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  whale_id:          uuid NOT NULL REFERENCES whales(id),
  max_size_usd:      numeric(18,2) NOT NULL,
  max_leverage:      int NOT NULL CHECK (max_leverage BETWEEN 1 AND 50),
  allowed_coins:     text[] NULL,        // NULL = all
  paused:            bool NOT NULL DEFAULT false,
  created_at:        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, whale_id),
  INDEX (whale_id, paused),
}

// fills (both whale source and our mirror; one row per HL fill we touch)
{
  id:                uuid PK,
  hl_fill_id:        text UNIQUE NOT NULL,
  wallet:            text NOT NULL,
  coin:              text NOT NULL,
  side:              text NOT NULL CHECK (side IN ('B','S')),
  px:                numeric(38,8) NOT NULL,
  sz:                numeric(38,8) NOT NULL,
  notional_usd:      numeric(18,2) NOT NULL,
  is_mirror:         bool NOT NULL,
  mirror_of_id:      uuid NULL REFERENCES fills(id),
  user_id:           uuid NULL REFERENCES users(id),    // null for whale-source rows
  builder_fee_tenths_bp: int NULL,
  builder_fee_usd:   numeric(18,6) NULL,
  ts:                timestamptz NOT NULL,
  INDEX (wallet, ts), INDEX (user_id, ts), INDEX (mirror_of_id),
}

// referrals
{
  code:              text PK,             // short, URL-safe
  owner_user_id:     uuid NOT NULL REFERENCES users(id),
  created_at:        timestamptz NOT NULL DEFAULT now(),
}
{
  // referrals_attribution
  referred_user_id:  uuid PK REFERENCES users(id),
  code:              text NOT NULL REFERENCES referrals(code),
  first_seen_at:     timestamptz NOT NULL DEFAULT now(),
}

// settings, notifications, etc. — straightforward, omitted for brevity

// audit & ops
{
  // audit_log
  id: uuid PK, actor: text, action: text, target: text,
  before_json: jsonb, after_json: jsonb, ts: timestamptz NOT NULL DEFAULT now(),
  INDEX (ts), INDEX (actor, ts),
}
{
  // kill_switches_global
  id int PK CHECK (id=1), enabled bool NOT NULL DEFAULT false, reason text NULL, set_by text, set_at timestamptz,
}
{
  // nonce_dedupe (Redis primary; Postgres fallback for >24h)
  // managed in Redis with TTL 24h
}
```

### 4.2 Indexes — discipline

Every query in production has a verified index. Drizzle migrations include `EXPLAIN ANALYZE` outputs committed alongside, demonstrating index usage on representative data.

### 4.3 Log redaction list (binding)

Pino config drops any field key matching this regex before serialization:

```
/^(secret|key|agentKey|secretKey|privateKey|signature|sig|r|s|v|nonce|maxFeeRate|password|token|bearer|jwt|apiKey|x-telegram-bot-api-secret-token)$/i
```

Plus value-pattern scrubbers for:

- 64-hex strings (private key shape) → `[REDACTED-HEX64]`
- 0x-prefixed 130-hex (signature shape) → `[REDACTED-SIG]`

CI test: synthetic log line containing each shape → assert redacted.

---

## 5. API Contract

### 5.1 TG bot commands

Each command takes inputs validated by zod and produces a typed response.

| Cmd                                  | Args                                              | Behavior                                                                      | Auth              |
| ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `/start`                             | optional ref code                                 | Greet, link to miniapp for onboarding                                         | tg-id             |
| `/track <0xaddr>`                    | address (validated)                               | Add whale to user's watch (no copy yet)                                       | tg-id + onboarded |
| `/copy <0xaddr> <max_usd> [max_lev]` | address, max-size USD (10-10000), leverage (1-25) | Create subscription                                                           | tg-id + onboarded |
| `/uncopy <0xaddr\|all>`              |                                                   | Remove subscription                                                           | tg-id + onboarded |
| `/pause`                             |                                                   | Pause all subs (kill_switch_user=true)                                        | tg-id + onboarded |
| `/resume`                            |                                                   | Unpause                                                                       | tg-id + onboarded |
| `/positions`                         |                                                   | Show open positions                                                           | tg-id + onboarded |
| `/close <coin\|all>`                 |                                                   | Market close at max slippage 0.5%                                             | tg-id + onboarded |
| `/settings`                          |                                                   | Open inline keyboard for limits                                               | tg-id + onboarded |
| `/share`                             |                                                   | Re-emit last PnL card                                                         | tg-id + onboarded |
| `/revoke`                            |                                                   | Set builder fee 0%, mark agent revoked, instructions to revoke agent on HL UI | tg-id + onboarded |
| `/about`                             |                                                   | Static text: capabilities, limitations, links                                 | public            |
| `/help`                              |                                                   | Command list                                                                  | public            |

Zod schemas live in `packages/schema`. Every command goes through a single middleware: validate → rate-limit → authorize → dispatch → audit-log.

### 5.2 Miniapp routes

| Route                        | Method | Body                                      | Returns                                                                                     |
| ---------------------------- | ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/onboard`                   | GET    | (TG initData via header)                  | Onboarding UI                                                                               |
| `/api/session`               | POST   | `{ initData }`                            | `{ jwt, ttl_s, miniapp_user_id }`                                                           |
| `/api/approve-agent/prepare` | POST   | `{ jwt }`                                 | EIP-712 typed-data for `approveAgent` (with fresh server-generated agent address) + `nonce` |
| `/api/approve-agent/submit`  | POST   | `{ jwt, signature, agentAddress, nonce }` | Submits to HL; persists encrypted agent key on success                                      |
| `/api/approve-fee/prepare`   | POST   | `{ jwt, maxFeeRate }`                     | EIP-712 typed-data for `approveBuilderFee`, with server-pinned `nonce` and `builder`        |
| `/api/approve-fee/submit`    | POST   | `{ jwt, signature, nonce }`               | Submits to HL                                                                               |
| `/api/revoke`                | POST   | `{ jwt }`                                 | Helper to construct the revocation calls                                                    |

All route handlers wrap in: nonce-dedupe → JWT verify → zod parse → handler → audit. Errors return generic 4xx; details only in server logs.

### 5.3 Bot-internal endpoints (Redis pub/sub, not HTTP)

| Stream             | Producer      | Consumer                | Payload                                           |
| ------------------ | ------------- | ----------------------- | ------------------------------------------------- |
| `mirror-intents`   | Mirror Engine | Order Router            | `{ subscriber_id, whale_fill_id, intent: {...} }` |
| `tg-notifications` | various       | Notification dispatcher | `{ user_id, kind, payload }`                      |
| `system-events`    | any           | Admin dashboard         | `{ severity, source, message }`                   |

---

## 6. Testing Strategy

| Layer         | Tool                                      | Target coverage                                                                              | Notes                                                                                                       |
| ------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unit          | vitest                                    | 90% statements, 85% branches in `packages/sdk` and Order Router                              | Pure functions; intent → action mapping                                                                     |
| Property      | fast-check                                | All order-construction and clamp functions                                                   | `∀ user inputs, fee_int ≤ approved_int`; `∀ size, clamped_size ≤ max_size`; `∀ leverage, clamped ≤ max_lev` |
| Integration   | vitest + testcontainers (Postgres, Redis) | All cross-component flows                                                                    | Spins up real Postgres + Redis.                                                                             |
| E2E (testnet) | Custom harness                            | Onboarding, copy, fill mirror, close, revoke                                                 | Runs against HL testnet on every release-candidate tag.                                                     |
| Fuzz          | fast-check                                | Webhook handler, miniapp body parser                                                         | 10K iterations CI run.                                                                                      |
| Chaos         | Custom                                    | WS disconnects (random kill), Redis flaps, HL 5xx                                            | Run nightly; alert on any failed recovery.                                                                  |
| Security      | Custom                                    | Signature replay, agent-withdraw attempt, fee-overcharge attempt, SQLi attempt, XSS payloads | Each scenario codified as a test, failure blocks merge.                                                     |
| Load          | k6                                        | 100 concurrent fills/sec mirror-engine throughput                                            | Pre-launch gate.                                                                                            |

**Coverage failure = CI failure.** No exceptions, including for "trivial" changes.

---

## 7. Observability

### 7.1 Logs

- **Logger:** pino with redaction (§4.3).
- **Sink:** Better Stack (free 1GB/mo).
- **Retention:** 7 days hot, 30 days cold. After 30 days, only aggregates retained.
- **Structured fields:** `service`, `env`, `request_id`, `user_id` (hashed), `route`, `latency_ms`, `outcome`.

### 7.2 Metrics (counters/gauges/histograms)

Emitted via OpenTelemetry → Better Stack metrics.

| Metric                        | Type      | Labels             | Why                                            |
| ----------------------------- | --------- | ------------------ | ---------------------------------------------- |
| `orders_submitted_total`      | counter   | outcome, coin      | Throughput                                     |
| `orders_latency_seconds`      | histogram | route              | SLO                                            |
| `mirror_fill_lag_seconds`     | histogram |                    | The product KPI: whale fill → our fill latency |
| `ws_reconnects_total`         | counter   | endpoint           | Health                                         |
| `builder_fee_collected_usd`   | counter   | (aggregated daily) | Revenue                                        |
| `users_onboarded_total`       | counter   | step               | Funnel                                         |
| `kms_decrypt_total`           | counter   | outcome            | Cost + security signal                         |
| `rate_limit_rejections_total` | counter   | route              | Abuse signal                                   |
| `kill_switch_state`           | gauge     | scope              | On/off                                         |

### 7.3 Traces

OpenTelemetry traces for: webhook → command dispatch → DB ops → KMS → HL POST. Sampling: 10% of normal traffic, 100% of errors.

### 7.4 Alerts (page you at 3 AM)

| Alert                     | Threshold      | Pages?            |
| ------------------------- | -------------- | ----------------- |
| Order failure rate        | >5% over 5min  | Yes               |
| Mirror fill lag p95       | >2s over 10min | Yes               |
| WS disconnect             | >60s           | Yes               |
| KMS decrypt failures      | any            | Yes               |
| Auth failures spike       | 10x baseline   | Yes               |
| Sentry critical error     | any            | Yes               |
| Kill switch enabled (any) | event          | Yes               |
| HL API 5xx rate           | >10% over 5min | Yes               |
| Daily revenue             | drops 50% wow  | No (daily review) |

On-call channel: dedicated TG channel `@whalepod_oncall` (private, you only). Better Stack → webhook → TG.

---

## 8. Incident Response Runbooks

Each runbook is a separate file in `docs/runbooks/`. Templates created at M0; details filled at M8. Required runbooks:

1. **`agent-key-compromise.md`** — KMS rotation, force re-approval for all users, public disclosure timing.
2. **`hl-outage.md`** — pause kill switch global, status banner, comms.
3. **`mass-liquidation.md`** — pause new mirrors, push notifications to affected users, no auto-close (we don't make those decisions).
4. **`abuse-spike.md`** — tighten rate limits, geofence by country if needed, Cloudflare WAF tighten.
5. **`webhook-token-leak.md`** — rotate webhook secret + TG bot token, redeploy.
6. **`db-corruption.md`** — restore from last hot backup, replay last 24h of fills from HL `info` endpoint.
7. **`kms-down.md`** — degraded mode (no new orders; existing positions safe).
8. **`founder-incapacitated.md`** — pointer to `BUS_FACTOR.md` (private).

Every runbook ends with a "How we verify normal operation has returned" checklist.

---

## 9. Pre-Launch Security Checklist (gates M9)

Every box must be ticked. PRs that touch security cannot be self-merged once this checklist is in active use (M8); they require a written sign-off comment from you the next calendar day.

### 9.1 Auth & access

- [ ] TG webhook secret token enforced.
- [ ] Miniapp HMAC of `initData` verified server-side.
- [ ] JWT TTL ≤ 5min.
- [ ] Admin dashboard behind Cloudflare Access + hardware key.
- [ ] All GitHub org members on hardware-key 2FA.
- [ ] Vercel, Fly.io, Supabase, Upstash, AWS, Better Stack, Sentry, Cloudflare: hardware-key 2FA only.
- [ ] No SMS recovery anywhere.

### 9.2 Secrets

- [ ] Bot token in KMS; loaded at boot.
- [ ] Webhook secret in KMS.
- [ ] DB password in KMS.
- [ ] Sentry/Better Stack tokens in KMS.
- [ ] No `.env` in production image.
- [ ] gitleaks pre-commit hook installed locally.
- [ ] GitHub push-protection enabled.
- [ ] All secrets logged-at-zero (synthetic test passes).

### 9.3 Crypto

- [ ] KMS master key created in us-east-1 (or chosen region); IAM role least-privilege.
- [ ] Per-user data key wrapping verified.
- [ ] Agent keys never persisted in plaintext anywhere.
- [ ] In-memory zeroization confirmed by test.
- [ ] EIP-712 domain `HyperliquidSignTransaction` v1; chainId `0xa4b1`; verified.
- [ ] Nonce dedupe 24h Redis + Postgres fallback.

### 9.4 Order integrity

- [ ] Fee `f` clamped to user-approved cap; property-tested.
- [ ] Withdraw paths absent from Order Router (grep + lint).
- [ ] Order intent → wire mapping property-tested.
- [ ] Builder address hard-coded constant per env.
- [ ] Mainnet/testnet flag from env, not request body.

### 9.5 Network & transport

- [ ] TLS 1.3 everywhere; HSTS preload eligible.
- [ ] CSP enforced (no `unsafe-inline`).
- [ ] Cloudflare WAF managed rules enabled.
- [ ] Rate limits configured per route.
- [ ] CORS: explicit origin allowlist.

### 9.6 Supply chain

- [ ] Lockfile committed; CI verifies no drift.
- [ ] `npm ci --ignore-scripts` everywhere.
- [ ] `npm audit signatures` green in CI.
- [ ] Dependabot active; no open high/critical >72h.
- [ ] CodeQL scan green.
- [ ] Docker base image digest-pinned.

### 9.7 Data

- [ ] No PII collected beyond TG user ID + wallet address.
- [ ] Daily encrypted DB backup verified by restore drill once before launch.
- [ ] Log redaction synthetic test passes.

### 9.8 Compliance / legal

- [ ] ToS reviewed by lawyer (gate).
- [ ] Privacy Policy reviewed by lawyer (gate).
- [ ] Geofence list configured (Cloudflare + TG-update country-code filter).
- [ ] `/about` command publishes capabilities and limitations.
- [ ] `security.txt` deployed at `/.well-known/security.txt`.
- [ ] PGP key published at `/.well-known/pgp.asc`.

### 9.9 Operations

- [ ] Runbooks 1–8 finalized.
- [ ] Killswitch tested (toggled on, verified orders blocked, toggled off).
- [ ] Alerts page on-call TG channel verified end-to-end.
- [ ] Status page (Better Stack public) live.
- [ ] On-call rotation: solo, 24/7 first week, documented (BUS_FACTOR.md updated).

### 9.10 Transparency

- [ ] Repos public (AGPL bot, Apache SDK, MIT web).
- [ ] Builder wallet address published on landing transparency page.
- [ ] `/about` command lists builder address.

---

## 10. What I Need From You To Proceed

1. **Confirm Phase 2 accepted** as written, or flag objections.
2. **Confirm AWS account created** with a region selected (recommend `us-east-1` — cheapest, most KMS features). I will scaffold IAM + KMS key in U2.
3. **Confirm hardware key purchased** (YubiKey 5 series, $50). This is non-negotiable for admin access and account 2FA. **Buy now if you have not.**
4. **Confirm builder revenue wallet address** generated on a hardware wallet (Ledger or similar). Share only the public address — never private key, never via this chat or any chat.

Once 1–4 are green, I begin **Phase 3: U1 — repo scaffold, CI, lint, typecheck, pre-commit, Dependabot, CodeQL**, and ship working code one unit at a time, gated on your "next" before each subsequent unit.
