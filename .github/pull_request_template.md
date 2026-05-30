## Summary

<!-- One sentence: what changes, and why. -->

## Unit / Milestone

<!-- e.g. U4 — HL SDK wrapper. Reference docs/phase-1.md milestones if relevant. -->

## Changes

-

## Security checklist

- [ ] No new direct `fetch`/`eval` calls
- [ ] No new code paths sign `withdraw3`, `usdSend`, or `spotSend`
- [ ] No secrets, keys, or tokens added to repo (verified by gitleaks)
- [ ] New logs redact addresses/keys/tokens
- [ ] New endpoints rate-limited and input-validated (zod)
- [ ] Threat model updated in `docs/phase-2.md` if trust boundary changed

## Tests

- [ ] Unit tests added/updated
- [ ] Coverage thresholds met for touched packages
- [ ] Manual verification steps documented below

## Rollback plan

<!-- How to revert in <5 min if this breaks prod. -->

## Definition of Done

- [ ] CI green
- [ ] CodeQL clean
- [ ] Reviewed (self-review acceptable for solo founder; document reasoning)
