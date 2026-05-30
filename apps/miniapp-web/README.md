# @whalepod/miniapp-web

Next.js 14 onboarding shell. Wraps the pure handlers in `@whalepod/miniapp`.

## Routes

- `GET /` — landing → link to `/onboard`
- `GET /onboard?tg=<telegramUserId>` — wallet-connect + EIP-712 signing flow
- `POST /api/onboarding/start` — wraps `onboardStartHandler`
- `POST /api/onboarding/complete` — wraps `onboardCompleteHandler`
- `GET /api/healthz`

## Env

```
AWS_REGION=us-east-1
VAULT_KMS_CMK_ARN=arn:aws:kms:...
BUILDER_ADDRESS=0x...
HL_CHAIN=Mainnet   # or Testnet
AGENT_NAME=WhalePod
```

## Local

```
npm install
npm run --workspace=@whalepod/miniapp-web dev
```

Open http://localhost:3000/onboard?tg=123456789

## Gates

This app has its own `next build` + `next lint` typecheck pipeline. It is intentionally
excluded from the root `tsc -b` and root `eslint .` runs to avoid pulling React JSX into
the server-side strictTypeChecked graph. To verify the shell, run inside this folder:

```
npm run --workspace=@whalepod/miniapp-web typecheck
npm run --workspace=@whalepod/miniapp-web build
```
