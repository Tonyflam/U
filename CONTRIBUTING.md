# Contributing to WhalePod

Thanks for your interest. This is a solo-founder project pre-launch; contribution bandwidth is limited but issues and small PRs are welcome.

## Before you start

- **Discuss first.** For anything beyond a typo or obvious bugfix, open an issue before writing code.
- **Read** `docs/phase-1.md` (strategy) and `docs/phase-2.md` (architecture + security model). PRs that conflict with the threat model will be rejected.
- **Sign your commits** with GPG or SSH (`git commit -S`). Unsigned commits to `main` are blocked.

## Workflow

1. Fork and branch from `main`.
2. `npm ci --ignore-scripts`
3. Run `npm run lint && npm run typecheck && npm run test` locally before pushing.
4. Pre-commit hooks run `gitleaks`, `prettier`, and `eslint`. Install gitleaks first.
5. Open a PR using the template; fill out the security checklist honestly.

## Code style

- TypeScript strict mode is non-negotiable. No `any`, no `!` non-null assertions, no `@ts-ignore`.
- No raw `fetch` — wrap in a typed client.
- Logs must redact addresses, keys, signatures, and tokens (see `pino` redaction config in U2).
- Test coverage thresholds are enforced per-package. Don't lower them.

## Licensing

By contributing you agree your contribution is licensed under the same terms as the file you modify (see `LICENSES.md`).

## What we will NOT merge

- Any code that adds a path to sign `withdraw3`, `usdSend`, or `spotSend`. Ever.
- Any code that stores user private keys outside KMS.
- Any code that bypasses builder-fee clamping.
- Anything that adds analytics tracking without an opt-out.
