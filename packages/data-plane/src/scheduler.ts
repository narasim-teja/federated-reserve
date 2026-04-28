/**
 * Periodic refresh scheduler.
 *
 * Owns the lifecycle of the upstream-data refresh:
 *   - kicks off an initial fetch on start()
 *   - schedules subsequent refreshes at `intervalMs`
 *   - tracks recent failures for the /healthz response
 *   - stops cleanly on stop()
 *
 * State-level FRED series tick monthly, so once-per-hour is plenty. The
 * default is configurable via the data-plane's env (`DATA_PLANE_REFRESH_MS`).
 */

import type { SnapshotCache } from './cache.ts';
import { fetchAllStates } from './sources/fred.ts';

interface SchedulerConfig {
  apiKey: string;
  cache: SnapshotCache;
  intervalMs: number;
}

export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inflight = false;
  private lastRefreshAt: string | null = null;
  private failuresLastHour: Array<{ at: number; error: string }> = [];

  constructor(private readonly cfg: SchedulerConfig) {}

  /** Run a single refresh, ignore overlap. */
  async refreshOnce(): Promise<void> {
    if (this.inflight) {
      console.log('[scheduler] refresh already in flight, skipping overlap');
      return;
    }
    this.inflight = true;
    const t0 = Date.now();
    try {
      console.log('[scheduler] refresh starting');
      const { snapshots, errors } = await fetchAllStates({ apiKey: this.cfg.apiKey });
      this.cfg.cache.setMany(snapshots);
      const populated = snapshots.filter((s) => Object.keys(s.indicators).length > 0).length;
      this.lastRefreshAt = new Date().toISOString();
      const ms = Date.now() - t0;
      console.log(
        `[scheduler] refresh done in ${ms}ms — ${populated}/${snapshots.length} states with data, ${errors.length} soft errors`,
      );
      // Keep last 5 errors visible for healthz (but log all).
      for (const e of errors.slice(0, 5)) {
        console.warn(`[scheduler]   ${e.state_abbr} ${e.series_id}: ${e.error}`);
      }
      if (errors.length > 0) {
        for (const e of errors) {
          this.failuresLastHour.push({ at: Date.now(), error: `${e.state_abbr}:${e.series_id}` });
        }
      }
      this.pruneFailures();
    } catch (err) {
      const ms = Date.now() - t0;
      console.error(`[scheduler] refresh failed after ${ms}ms: ${String(err)}`);
      this.failuresLastHour.push({ at: Date.now(), error: String(err) });
      this.pruneFailures();
    } finally {
      this.inflight = false;
    }
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      await this.refreshOnce();
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.cfg.intervalMs);
      }
    };
    // Fire-and-forget the first refresh; don't block server startup on it
    // (we already have hydrated cache values from disk).
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  health(): { last_refresh_at: string | null; upstream_failures_last_hour: number } {
    this.pruneFailures();
    return {
      last_refresh_at: this.lastRefreshAt,
      upstream_failures_last_hour: this.failuresLastHour.length,
    };
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.failuresLastHour = this.failuresLastHour.filter((f) => f.at >= cutoff);
  }
}
