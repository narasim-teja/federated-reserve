/**
 * FRED ingestion source.
 *
 * Pulls per-state series from the St. Louis Fed FRED API:
 *   - `{ABBR}UR`     unemployment rate, monthly, %
 *   - `{ABBR}PCPI`   per-capita personal income, annual, USD
 *   - `{ABBR}NGSP`   nominal GDP, annual, $M (some states only)
 *
 * Rate-limited via the shared TokenBucket. State-level monthly series tick
 * once a month, so refreshing hourly is overkill but cheap (50 states ×
 * ~3 series = ~150 requests, ~2 minutes at 1.3 req/s).
 *
 * No fallback to fake data on failure: caller surfaces the error and the
 * cache continues to serve last-known values.
 */

import {
  type EconomicIndicatorKind,
  type IndicatorObservation,
  STATES,
  type StateInfo,
  type StateSnapshot,
} from '@federated-reserve/shared';
import { z } from 'zod';
import { TokenBucket, runWithConcurrency } from '../rate-limit.ts';

// FRED budget: 120 req/min documented. We saw 429s in practice well below
// that, so we run conservatively at 60 req/min (1 req/sec). Real-world
// state-series volume is ~104 reqs once per hour — well within budget.
const FRED_RATE_LIMITER = new TokenBucket({ ratePerSec: 1 });

const fredObservationSchema = z.object({
  date: z.string(),
  /** "." indicates missing; otherwise a numeric string. */
  value: z.string(),
});

const fredResponseSchema = z.object({
  observations: z.array(fredObservationSchema).default([]),
});

export interface FredSeriesSpec {
  /** Indicator kind we map this FRED series to. */
  kind: EconomicIndicatorKind;
  /** FRED series ID template; `{abbr}` substituted at fetch time. */
  template: string;
  /** Optional value transform (e.g. to convert dollars → percentage). */
  transform?: (value: number) => number;
}

export const DEFAULT_FRED_SERIES: readonly FredSeriesSpec[] = [
  { kind: 'unemployment', template: '{abbr}UR' },
  { kind: 'personal_income', template: '{abbr}PCPI' },
];

interface FetchSeriesOptions {
  apiKey: string;
  abbr: string;
  spec: FredSeriesSpec;
  signal?: AbortSignal;
}

const RETRY_DELAYS_MS = [1500, 4000, 9000] as const;

async function fetchLatestSeries(opts: FetchSeriesOptions): Promise<IndicatorObservation | null> {
  const seriesId = opts.spec.template.replace('{abbr}', opts.abbr);

  // Retry loop covers transient 429s and 5xxs. Rate-limiter acquisition
  // happens *inside* the retry loop so each retry waits for a fresh slot.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await FRED_RATE_LIMITER.acquire();

    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', opts.apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('sort_order', 'desc');
    url.searchParams.set('limit', '1');

    const res = await fetch(url, { signal: opts.signal });

    // Retryable: 429 and 5xx
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`FRED ${res.status} on ${seriesId}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastErr;
    }

    // 400 — typically means series doesn't exist for that state. Skip silently.
    if (res.status === 400) return null;

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`FRED ${res.status} on ${seriesId}: ${body}`);
    }

    const json = await res.json();
    const parsed = fredResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`FRED bad response for ${seriesId}: ${parsed.error.message}`);
    }
    const latest = parsed.data.observations[0];
    if (!latest || latest.value === '.') return null;

    const numeric = Number(latest.value);
    if (!Number.isFinite(numeric)) return null;

    const value = opts.spec.transform ? opts.spec.transform(numeric) : numeric;
    return {
      value,
      observation_date: latest.date,
      source: `FRED:${seriesId}`,
      fetched_at: new Date().toISOString(),
    };
  }

  // unreachable, but keeps tsc happy
  throw lastErr ?? new Error('FRED fetch failed');
}

export interface FetchAllOptions {
  apiKey: string;
  /** Subset of states to fetch (defaults to all 50+DC+PR). */
  states?: readonly StateInfo[];
  /** Series to fetch per state (defaults to unemployment + personal income). */
  series?: readonly FredSeriesSpec[];
  /** Concurrency cap for parallel fetches. */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface FetchAllResult {
  snapshots: StateSnapshot[];
  /** Per-(state,series) errors that didn't take the whole run down. */
  errors: Array<{ state_abbr: string; series_id: string; error: string }>;
}

/**
 * Fetch all configured series for all configured states.
 *
 * Returns a list of `StateSnapshot`s plus a list of soft errors. A run is
 * considered successful as long as at least one snapshot lands; the caller
 * decides whether to flush partials to the cache (we do).
 */
export async function fetchAllStates(opts: FetchAllOptions): Promise<FetchAllResult> {
  const states = opts.states ?? STATES;
  const series = opts.series ?? DEFAULT_FRED_SERIES;
  // Concurrency is mostly cosmetic now that the rate limiter serializes
  // — keep at 2 so the second worker preps its URL while the first is
  // in flight, masking some network latency.
  const concurrency = opts.concurrency ?? 2;
  const errors: FetchAllResult['errors'] = [];

  const snapshots = await runWithConcurrency(states, concurrency, async (state) => {
    const indicators: StateSnapshot['indicators'] = {};

    for (const spec of series) {
      const seriesId = spec.template.replace('{abbr}', state.abbr);
      try {
        const obs = await fetchLatestSeries({
          apiKey: opts.apiKey,
          abbr: state.abbr,
          spec,
          signal: opts.signal,
        });
        if (obs) indicators[spec.kind] = obs;
      } catch (err) {
        errors.push({
          state_abbr: state.abbr,
          series_id: seriesId,
          error: String(err),
        });
      }
    }

    return {
      state_fips: state.fips,
      state_abbr: state.abbr,
      refreshed_at: new Date().toISOString(),
      indicators,
    } satisfies StateSnapshot;
  });

  return { snapshots, errors };
}
