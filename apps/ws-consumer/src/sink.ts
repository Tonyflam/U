import type { MirrorIntent } from './types.js';

/**
 * Output sink for emitted MirrorIntents.
 *
 * Production: an Upstash-Redis-backed implementation appending to the
 * `mirror-intents` stream. Tests: an in-memory recorder.
 *
 * `emit` is idempotent on `intent.idempotencyKey`. Returns true if the
 * intent was newly recorded, false if it was a duplicate of one already
 * seen in the dedupe window.
 */
export interface IntentSink {
  emit(intent: MirrorIntent): Promise<boolean>;
}

/** Test/in-memory sink with explicit recall. */
export class InMemoryIntentSink implements IntentSink {
  readonly recorded: MirrorIntent[] = [];
  private readonly seen = new Set<string>();

  emit(intent: MirrorIntent): Promise<boolean> {
    if (this.seen.has(intent.idempotencyKey)) {
      return Promise.resolve(false);
    }
    this.seen.add(intent.idempotencyKey);
    this.recorded.push(intent);
    return Promise.resolve(true);
  }
}
