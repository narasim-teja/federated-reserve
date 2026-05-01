/**
 * Periodic refresh scheduler.
 *
 * Phase 4+ wave: merges FRED + BLS + BEA + Census + NOAA into one cycle.
 * Each source has its own rate limiter (defined in its own module) and
 * runs serialized inside `refreshOnce()`. Per-source liveness is tracked
 * separately so /healthz can show "FRED stale, NOAA fresh" granularity.
 *
 * Sources are best-effort: a failure in one source doesn't block the others.
 * Cache writes are merged additively — a state's snapshot is the union of
 * indicators from all populated sources.
 */

import { type StateSnapshot, lookupStateByFips } from '@federated-reserve/shared';
import type { SnapshotCache } from './cache.ts';
import type { ShockCache } from './shock-cache.ts';
import { fetchBeaRegional } from './sources/bea.ts';
import { fetchBlsLaus } from './sources/bls.ts';
import { fetchCensusAcs } from './sources/census.ts';
import { fetchAllStates as fetchAllFred } from './sources/fred.ts';
import { fetchNoaaActiveShocks } from './sources/noaa.ts';

export interface SchedulerKeys {
  fred?: string;
  bls?: string;
  bea?: string;
  census?: string;
}

interface SchedulerConfig {
  keys: SchedulerKeys;
  cache: SnapshotCache;
  shockCache: ShockCache;
  intervalMs: number;
}

export interface SourceLiveness {
  last_refresh_at: string | null;
  last_error: string | null;
}

export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inflight = false;
  private lastRefreshAt: string | null = null;
  private failuresLastHour: Array<{ at: number; error: string }> = [];
  private readonly liveness: Record<string, SourceLiveness> = {
    fred: { last_refresh_at: null, last_error: null },
    bls: { last_refresh_at: null, last_error: null },
    bea: { last_refresh_at: null, last_error: null },
    census: { last_refresh_at: null, last_error: null },
    noaa: { last_refresh_at: null, last_error: null },
  };

  constructor(private readonly cfg: SchedulerConfig) {}

  async refreshOnce(): Promise<void> {
    if (this.inflight) {
      console.log('[scheduler] refresh already in flight, skipping overlap');
      return;
    }
    this.inflight = true;
    const t0 = Date.now();
    try {
      console.log('[scheduler] refresh starting');

      const stateSnapshots = new Map<number, StateSnapshot>();

      // 1) FRED
      const fredKey = this.cfg.keys.fred;
      if (this.keyOk(fredKey)) {
        try {
          const { snapshots, errors } = await fetchAllFred({ apiKey: fredKey });
          for (const s of snapshots) stateSnapshots.set(s.state_fips, s);
          if (errors.length > 0) {
            this.recordSourceError(
              'fred',
              `${errors.length} soft errors (e.g. ${errors[0]?.series_id}: ${errors[0]?.error})`,
            );
          } else {
            this.markSourceOk('fred');
          }
        } catch (err) {
          this.recordSourceError('fred', String(err));
        }
      }

      // 2) BLS LAUS
      const blsKey = this.cfg.keys.bls;
      if (this.keyOk(blsKey)) {
        try {
          const bls = await fetchBlsLaus({ apiKey: blsKey });
          mergeIntoStateSnapshots(stateSnapshots, bls.perStateIndicators);
          if (bls.errors.length > 0) {
            this.recordSourceError(
              'bls',
              `${bls.errors.length} soft errors (e.g. ${bls.errors[0]?.error})`,
            );
          } else {
            this.markSourceOk('bls');
          }
        } catch (err) {
          this.recordSourceError('bls', String(err));
        }
      }

      // 3) BEA Regional
      const beaKey = this.cfg.keys.bea;
      if (this.keyOk(beaKey)) {
        try {
          const bea = await fetchBeaRegional({ apiKey: beaKey });
          mergeIntoStateSnapshots(stateSnapshots, bea.perStateIndicators);
          if (bea.errors.length > 0) {
            this.recordSourceError(
              'bea',
              `${bea.errors.length} soft errors (e.g. ${bea.errors[0]?.error})`,
            );
          } else {
            this.markSourceOk('bea');
          }
        } catch (err) {
          this.recordSourceError('bea', String(err));
        }
      }

      // 4) Census ACS 5-year
      const censusKey = this.cfg.keys.census;
      if (this.keyOk(censusKey)) {
        try {
          const census = await fetchCensusAcs({ apiKey: censusKey });
          mergeIntoStateSnapshots(stateSnapshots, census.perStateIndicators);
          if (census.errors.length > 0) {
            this.recordSourceError(
              'census',
              `${census.errors.length} soft errors (e.g. ${census.errors[0]?.error})`,
            );
          } else {
            this.markSourceOk('census');
          }
        } catch (err) {
          this.recordSourceError('census', String(err));
        }
      }

      // Flush merged state snapshots.
      const snapList = [...stateSnapshots.values()];
      if (snapList.length > 0) {
        this.cfg.cache.setMany(snapList);
        const populated = snapList.filter((s) => Object.keys(s.indicators).length > 0).length;
        const sample = snapList.find((s) => Object.keys(s.indicators).length > 2);
        console.log(
          `[scheduler] state snapshots merged — ${populated}/${snapList.length} states with ≥1 indicator${
            sample
              ? ` (e.g. ${sample.state_abbr}: ${Object.keys(sample.indicators).join(',')})`
              : ''
          }`,
        );
      }

      // 5) NOAA shocks (no key)
      try {
        const noaa = await fetchNoaaActiveShocks();
        this.cfg.shockCache.setAll(noaa.events);
        if (noaa.errors.length > 0) {
          this.recordSourceError('noaa', noaa.errors[0]?.error ?? 'unknown');
        } else {
          this.markSourceOk('noaa');
        }
        console.log(`[scheduler] NOAA: ${noaa.events.length} active shocks cached`);
      } catch (err) {
        this.recordSourceError('noaa', String(err));
      }

      this.lastRefreshAt = new Date().toISOString();
      const ms = Date.now() - t0;
      console.log(`[scheduler] refresh done in ${ms}ms`);
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
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  health(): {
    last_refresh_at: string | null;
    upstream_failures_last_hour: number;
    sources: Record<string, SourceLiveness>;
  } {
    this.pruneFailures();
    return {
      last_refresh_at: this.lastRefreshAt,
      upstream_failures_last_hour: this.failuresLastHour.length,
      sources: this.liveness,
    };
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.failuresLastHour = this.failuresLastHour.filter((f) => f.at >= cutoff);
  }

  private markSourceOk(name: string): void {
    const s = this.liveness[name];
    if (!s) return;
    s.last_refresh_at = new Date().toISOString();
    s.last_error = null;
  }

  private recordSourceError(name: string, err: string): void {
    const s = this.liveness[name];
    if (!s) return;
    s.last_error = err;
    this.failuresLastHour.push({ at: Date.now(), error: `${name}:${err}` });
  }

  private keyOk(key: string | undefined): key is string {
    return Boolean(key && !key.startsWith('PLACEHOLDER') && key.length > 4);
  }
}

function mergeIntoStateSnapshots(
  target: Map<number, StateSnapshot>,
  perFips: Map<number, Partial<StateSnapshot['indicators']>>,
): void {
  for (const [fips, indicators] of perFips) {
    const existing = target.get(fips);
    if (existing) {
      target.set(fips, {
        ...existing,
        indicators: { ...existing.indicators, ...indicators },
        refreshed_at: new Date().toISOString(),
      });
    } else {
      const stateInfo = lookupStateByFips(fips);
      if (!stateInfo) continue;
      target.set(fips, {
        state_fips: fips,
        state_abbr: stateInfo.abbr,
        refreshed_at: new Date().toISOString(),
        indicators,
      });
    }
  }
}
