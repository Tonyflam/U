/**
 * CLI entry for the HL testnet smoke harness.
 *
 *   HL_NETWORK=testnet npx tsx apps/bot/src/smokeCli.ts
 *
 * Defaults to testnet. Exit 0 = green, non-zero = probe failure.
 */
import { runSmoke } from './smoke.js';

runSmoke().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[smoke] FAIL ${msg}\n`);
  process.exit(1);
});
