# Licenses

WhalePod is a multi-package monorepo with intentionally different licenses per package.

| Package           | License           | Why                                              |
| ----------------- | ----------------- | ------------------------------------------------ |
| `apps/bot`        | AGPL-3.0-or-later | Network-effect protection on the trading service |
| `apps/miniapp`    | AGPL-3.0-or-later | Same                                             |
| `apps/admin`      | AGPL-3.0-or-later | Same                                             |
| `apps/web`        | MIT               | Public landing site; permissive on purpose       |
| `packages/sdk`    | Apache-2.0        | Reusable HL SDK wrapper; patent grant matters    |
| `packages/schema` | Apache-2.0        | Reusable types                                   |
| `packages/ui`     | MIT               | Reusable React components                        |

License texts live at the repo root: [LICENSE-AGPL](LICENSE-AGPL), [LICENSE-APACHE](LICENSE-APACHE), [LICENSE-MIT](LICENSE-MIT).

If you depend on a single package, refer to that package's `package.json` `license` field as the authoritative source.

Copyright © 2025 WhalePod contributors.
