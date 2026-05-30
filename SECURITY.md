# Security Policy

## Supported versions

Pre-launch. Only `main` is supported. Once we tag `v1.0.0` we will list supported versions here.

## Reporting a vulnerability

Email **security@whalepod.trade** with:

- A description of the issue
- Reproduction steps or PoC
- Impact assessment (what funds / accounts / data are at risk)
- Your contact + optional PGP key

You will receive an acknowledgement within **48 hours**. We aim to triage critical reports within **72 hours** and ship a fix within **7 days** for high-severity issues.

Please **do not** open a public GitHub issue for security reports.

## Scope

In scope:

- All code in this repository (bot, miniapp, web, admin, sdk, schema, ui)
- Production deployments at `whalepod.trade`, `app.whalepod.trade`, `t.me/whalepod_bot`
- Hyperliquid order signing path, builder fee handling, agent wallet vault, KMS interactions

Out of scope:

- The Hyperliquid protocol itself (report to Hyperliquid)
- Telegram, Vercel, Fly.io, Supabase, Upstash, AWS, Cloudflare infrastructure (report to vendors)
- Social engineering of the maintainer
- Denial of service via volumetric attacks against shared infra

## Safe harbor

Good-faith research that:

- Avoids privacy violations of other users
- Avoids destruction of data
- Avoids degradation of service
- Stops as soon as a vulnerability is confirmed

…will not be subject to legal action by WhalePod.

## Recognition

We do not currently pay a bug bounty (zero-revenue pre-launch). Severe findings receive credit in release notes (with your permission) and may be eligible for retroactive bounty after launch revenue is established.

## Hardcoded protocol invariants

These properties of the system are guaranteed by code and protocol; violating them is automatically critical:

1. The service **never signs** `withdraw3`, `usdSend`, or `spotSend` actions. Code paths are physically absent; agent keys cannot sign these on Hyperliquid by protocol.
2. Builder fee is **clamped at the SDK layer** to the user-approved `maxFeeRate` (default 5 bps, cap 10 bps for perps).
3. Agent private keys exist in plaintext **only inside one process during a single order-sign operation** (~10ms) and are zeroized in a `finally` block.
4. Long-term key custody is **AWS KMS only**; the service never sees the master key material.
