# WhalePod

> mirror hyperliquid whales from telegram. non-custodial. [whalepod.trade](https://whalepod.trade)

WhalePod is a Telegram-native copy-trading client for [Hyperliquid](https://hyperliquid.xyz) perps. Users approve a per-device agent key and a builder fee once in a mini-app; from then on they tap `/copy <whale>` in chat and every fill is mirrored to their own wallet. Funds never leave the user's account.

**Status:** pre-launch. See [docs/phase-1.md](docs/phase-1.md) for strategy and [docs/phase-2.md](docs/phase-2.md) for architecture.

## How it works

1. Connect wallet in the mini-app (one tap, EIP-712 sig, no funds transfer).
2. Approve a builder fee (default 5 bps, hard cap 10 bps per Hyperliquid protocol).
3. `/track 0xWhale` in the bot to watch a whale.
4. `/copy 0xWhale --size 25%` to mirror their fills proportionally.
5. Get a Telegram notification + PnL card every time you fill.

## Non-custodial guarantees

- Your master key never leaves your wallet.
- The agent key WhalePod uses has **no withdrawal authority** — Hyperliquid protocol enforces this.
- Revoke at any time from the mini-app or by resetting the agent on Hyperliquid directly.

## Repo

Monorepo, npm workspaces, TypeScript strict.

```
apps/
  bot/       Telegram bot           (AGPL-3.0)
  miniapp/   Wallet approval UI     (AGPL-3.0)
  web/       Landing site           (MIT)
  admin/     Internal dashboard     (AGPL-3.0)
packages/
  sdk/       Hyperliquid wrapper    (Apache-2.0)
  schema/    Shared zod + types     (Apache-2.0)
  ui/        Shared React           (MIT)
```

## Develop

Requires Node `22.11.0` (see [.nvmrc](.nvmrc)) and npm `>=10.9`.

```bash
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run test
```

## Security

Report vulnerabilities to **security@whalepod.trade**. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Discuss in an issue first.

## License

Multi-license. See [LICENSES.md](LICENSES.md).
