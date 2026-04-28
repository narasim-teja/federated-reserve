/**
 * Token-bucket rate limiter.
 *
 * Per-source budget: tokens refill at `ratePerSec`, bucket caps at `burst`.
 * `acquire()` resolves when a token is available — callers serialize through
 * the same limiter for a single upstream API.
 *
 * FRED budget: 120 req/min documented limit → we use 80 req/min (~1.33/s) at
 * burst 8 to leave headroom for retries and shared usage.
 */

export interface RateLimiterConfig {
  /** Steady-state tokens per second. */
  ratePerSec: number;
  /** Maximum tokens accumulated when idle. */
  burst: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private waiters: Array<() => void> = [];

  constructor(private readonly cfg: RateLimiterConfig) {
    this.tokens = cfg.burst;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.cfg.burst, this.tokens + elapsedSec * this.cfg.ratePerSec);
    this.lastRefillMs = now;
  }

  /** Resolves when one token is available, then consumes it. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for next refill tick.
    const waitMs = ((1 - this.tokens) / this.cfg.ratePerSec) * 1000;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(
        () => {
          this.refill();
          const next = this.waiters.shift();
          if (next) {
            this.tokens = Math.max(0, this.tokens - 1);
            next();
          } else {
            resolve();
          }
        },
        Math.max(50, waitMs),
      );
    });
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Bounded concurrency runner — `n` tasks at a time. Used in addition to
 * rate limiting so we don't hammer the upstream with N parallel TCP
 * connections even when the token bucket would allow it.
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
