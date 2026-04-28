/**
 * Rate limiter — minimum interval between releases.
 *
 * Older draft tried a token-bucket with bursts, but with concurrent waiters
 * the refill+resolve sequence drifted: each setTimeout independently called
 * refill() and decremented tokens, allowing several waiters to release at
 * almost the same time. Result was an effective rate ~4× higher than
 * configured — FRED returned a wall of 429s on the first refresh.
 *
 * This is the simpler design: one shared promise chain enforces a minimum
 * interval between consecutive `acquire()` resolutions. With `ratePerSec=1.33`
 * (80 req/min), `acquire()` resolves at most every 750ms regardless of how
 * many callers are waiting. No bursting, no drift. Concurrency at the
 * caller level no longer helps (everyone serializes through the chain),
 * which is what we actually want when FRED's published limit is 120/min.
 */

export interface RateLimiterConfig {
  /** Steady-state allowed rate. */
  ratePerSec: number;
}

export class TokenBucket {
  private readonly minIntervalMs: number;
  private nextAvailableAt = 0;
  /** Sequencing chain so concurrent `acquire()` calls release in FIFO order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(cfg: RateLimiterConfig) {
    if (cfg.ratePerSec <= 0) throw new Error('ratePerSec must be > 0');
    this.minIntervalMs = 1000 / cfg.ratePerSec;
  }

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAvailableAt - now);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.nextAvailableAt = Math.max(now, this.nextAvailableAt) + this.minIntervalMs;
    });
    // Swallow rejection so one failure doesn't stall the queue. Caller still
    // sees the original promise resolution semantics.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Bounded concurrency runner — `n` tasks at a time. Pairs with the limiter
 * for I/O parallelism even when the rate is conservative (so latency hits
 * are masked by overlapping in-flight requests, while the limiter still
 * caps the issue rate).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
