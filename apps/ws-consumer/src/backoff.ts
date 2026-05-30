/**
 * Exponential backoff with full jitter.
 *
 *   attempt n (0-indexed) → random in [0, base * 2^n) capped at maxMs.
 *
 * Full jitter (per AWS Architecture Blog "Exponential Backoff and Jitter")
 * gives the best convergence under shared-fate reconnects across a fleet.
 *
 * `rng` is injected for deterministic tests.
 */
export function backoffMs(
  attempt: number,
  options: { readonly baseMs: number; readonly maxMs: number; readonly rng?: () => number },
): number {
  const rng = options.rng ?? Math.random;
  const a = Math.max(0, Math.floor(attempt));
  // Cap the exponent so we don't overflow on long-lived processes.
  const expCap = 30;
  const window = Math.min(options.maxMs, options.baseMs * Math.pow(2, Math.min(a, expCap)));
  return Math.floor(rng() * Math.max(1, window));
}
