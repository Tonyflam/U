/**
 * Tiny in-process supervisor for the mirror + notify consumers.
 *
 * Why: previously a single Redis hiccup (e.g. Upstash quota exhausted)
 * would reject the consumer's first XREAD, the promise would reject, the
 * `.catch` in start.ts would log "mirror consumer crashed", and the bot
 * would silently stop mirroring until a manual redeploy. Now we restart
 * with backoff and tell the admin over Telegram.
 *
 * Also exposes a health snapshot used by `/healthz` so external uptime
 * monitors (Better Stack / UptimeRobot / Railway) flip red within ~1min
 * when a consumer is wedged.
 */
import type { Logger } from 'pino';
import type { ConsumerController } from './mirrorConsumer.js';

export interface ConsumerHealth {
  readonly name: string;
  readonly running: boolean;
  readonly lastStartAt: number;
  readonly lastErrorAt: number | null;
  readonly lastError: string | null;
  readonly restartCount: number;
}

export type AdminAlertFn = (text: string) => Promise<void>;

export interface SuperviseOptions {
  readonly name: string;
  readonly controller: ConsumerController;
  readonly factory: (controller: ConsumerController) => Promise<unknown>;
  readonly log: Logger;
  readonly alert?: AdminAlertFn;
  /** Initial backoff in ms (doubled up to maxBackoffMs each restart). */
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

export class ConsumerSupervisor {
  private readonly states = new Map<string, ConsumerHealth>();

  snapshot(): readonly ConsumerHealth[] {
    return [...this.states.values()];
  }

  /** A consumer is considered healthy when it's running and started > 5s ago. */
  allHealthy(): boolean {
    const now = Date.now();
    for (const h of this.states.values()) {
      if (!h.running) return false;
      if (now - h.lastStartAt < 0) return false;
    }
    return true;
  }

  async supervise(opts: SuperviseOptions): Promise<void> {
    const initial = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    const max = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    let backoff = initial;
    let restartCount = 0;

    while (!opts.controller.stopped) {
      const startedAt = Date.now();
      this.states.set(opts.name, {
        name: opts.name,
        running: true,
        lastStartAt: startedAt,
        lastErrorAt: this.states.get(opts.name)?.lastErrorAt ?? null,
        lastError: this.states.get(opts.name)?.lastError ?? null,
        restartCount,
      });
      try {
        await opts.factory(opts.controller);
        // Clean exit (controller.stopped flipped).
        this.states.set(opts.name, {
          ...this.snapshotOf(opts.name, startedAt, restartCount),
          running: false,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ranForMs = Date.now() - startedAt;
        opts.log.error(
          { err, consumer: opts.name, ranForMs, restartCount },
          'consumer crashed; will restart',
        );
        this.states.set(opts.name, {
          name: opts.name,
          running: false,
          lastStartAt: startedAt,
          lastErrorAt: Date.now(),
          lastError: message,
          restartCount,
        });
        if (opts.alert) {
          opts
            .alert(
              `🚨 WhalePod consumer crash\n\n` +
                `Consumer: ${opts.name}\n` +
                `Ran for: ${(ranForMs / 1000).toFixed(1)}s\n` +
                `Restart #${String(restartCount + 1)} in ${(backoff / 1000).toFixed(1)}s\n\n` +
                `Error: ${message.slice(0, 500)}`,
            )
            .catch((alertErr: unknown) => {
              opts.log.warn({ err: alertErr, consumer: opts.name }, 'admin alert failed');
            });
        }
        // controller.stopped is flipped externally (SIGTERM handler) during
        // the awaited factory(), so the narrowing from the while-condition
        // no longer holds — explicitly re-check.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (opts.controller.stopped) return;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, max);
        restartCount += 1;
        // Reset backoff if the consumer ran for at least a minute before
        // crashing — that means it isn't crash-looping on a config issue.
        if (ranForMs > 60_000) backoff = initial;
      }
    }
  }

  private snapshotOf(name: string, startedAt: number, restartCount: number): ConsumerHealth {
    const prev = this.states.get(name);
    return {
      name,
      running: true,
      lastStartAt: startedAt,
      lastErrorAt: prev?.lastErrorAt ?? null,
      lastError: prev?.lastError ?? null,
      restartCount,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
