/**
 * BLS LAUS (Local Area Unemployment Statistics) ingestion.
 *
 * Why both FRED and BLS? FRED state series are convenient but lag; BLS LAUS
 * is the upstream-of-FRED source with one extra month of timeliness during
 * employment shocks and gives us employment *level* and labor force counts
 * that FRED's `{ABBR}UR` series collapses into a single percentage. The
 * agent reasoner uses both: unemployment % for credit rating, employment
 * count + labor force for sizing aid commitments.
 *
 * Series ID format (LAUS):
 *   `LAU` + `S` (state) + state-FIPS-padded + `0000000000` + measure-code
 *   measure-codes: `03` unemployment rate, `04` unemployment count,
 *                  `05` employment count, `06` labor force.
 *
 * Endpoint: https://api.bls.gov/publicAPI/v2/timeseries/data/
 *   POST { seriesid: [...], registrationkey: <key>, startyear, endyear }
 *   Up to 50 series per request, 500 req/day registered.
 */

import {
  type EconomicIndicatorKind,
  type IndicatorObservation,
  STATES,
  type StateInfo,
  type StateSnapshot,
} from '@federated-reserve/shared';
import { z } from 'zod';
import { TokenBucket } from '../rate-limit.ts';

// 500/day = ~20/hour in steady state; 1 req/sec is plenty under that ceiling.
const BLS_RATE_LIMITER = new TokenBucket({ ratePerSec: 1 });

const BLS_BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

// LAUS measure codes
const MEASURE_UNEMPLOYMENT_RATE = '03';
const MEASURE_EMPLOYMENT = '05';
const MEASURE_LABOR_FORCE = '06';

interface SeriesAssignment {
  kind: EconomicIndicatorKind;
  measure: string;
}

const SERIES_PER_STATE: readonly SeriesAssignment[] = [
  { kind: 'unemployment', measure: MEASURE_UNEMPLOYMENT_RATE },
  { kind: 'employment_count', measure: MEASURE_EMPLOYMENT },
  { kind: 'labor_force', measure: MEASURE_LABOR_FORCE },
];

const blsObservationSchema = z.object({
  year: z.string(),
  period: z.string(), // "M01".."M12"
  periodName: z.string().optional(),
  value: z.string(),
  latest: z.string().optional(),
});

const blsSeriesSchema = z.object({
  seriesID: z.string(),
  data: z.array(blsObservationSchema).default([]),
});

const blsResponseSchema = z.object({
  status: z.string(),
  responseTime: z.number().optional(),
  message: z.array(z.string()).optional(),
  Results: z
    .object({
      series: z.array(blsSeriesSchema).default([]),
    })
    .optional(),
});

function lausSeriesId(stateFips: number, measure: string): string {
  // BLS state FIPS are 2-digit zero-padded (e.g. 06 for CA, 25 for MA)
  const fipsStr = String(stateFips).padStart(2, '0');
  return `LAUS${fipsStr}0000000000${measure}`;
}

function periodToIso(year: string, period: string): string | null {
  // period is "M01".."M12"; "M13" is annual avg, skip it
  if (!period.startsWith('M')) return null;
  const month = Number(period.slice(1));
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  const monthStr = String(month).padStart(2, '0');
  return `${year}-${monthStr}-01`;
}

const RETRY_DELAYS_MS = [1500, 4000, 9000] as const;

interface FetchBlsBatchOptions {
  apiKey: string;
  seriesIds: readonly string[];
  startYear: number;
  endYear: number;
  signal?: AbortSignal;
}

async function fetchBlsBatch(
  opts: FetchBlsBatchOptions,
): Promise<z.infer<typeof blsResponseSchema>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await BLS_RATE_LIMITER.acquire();
    const res = await fetch(BLS_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seriesid: [...opts.seriesIds],
        startyear: String(opts.startYear),
        endyear: String(opts.endYear),
        registrationkey: opts.apiKey,
      }),
      signal: opts.signal,
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`BLS ${res.status}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`BLS ${res.status}: ${body}`);
    }
    const json = await res.json();
    const parsed = blsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`BLS bad response: ${parsed.error.message}`);
    }
    if (parsed.data.status !== 'REQUEST_SUCCEEDED') {
      const msgs = parsed.data.message?.join('; ') ?? 'unknown';
      throw new Error(`BLS request not OK: ${parsed.data.status} ${msgs}`);
    }
    return parsed.data;
  }
  throw lastErr ?? new Error('BLS fetch failed');
}

export interface BlsFetchAllResult {
  /** keyed by stateFips, map of indicatorKind → observation. */
  perStateIndicators: Map<number, Partial<Record<EconomicIndicatorKind, IndicatorObservation>>>;
  errors: Array<{ state_abbr: string; series_id: string; error: string }>;
}

/**
 * Fetch latest LAUS observations for the given states.
 * Batches up to 25 series per request (well under BLS 50-series cap), so
 * 50 states × 3 series = 6 batches per refresh — way under 500/day.
 */
export async function fetchBlsLaus(opts: {
  apiKey: string;
  states?: readonly StateInfo[];
  signal?: AbortSignal;
}): Promise<BlsFetchAllResult> {
  const states = opts.states ?? STATES.filter((s) => s.fips < 100); // skip federal
  const now = new Date();
  const endYear = now.getUTCFullYear();
  const startYear = endYear - 1;

  // Build seriesId → (fips, kind) reverse map for re-keying responses.
  type Meta = { fips: number; abbr: string; kind: EconomicIndicatorKind };
  const seriesMeta = new Map<string, Meta>();
  for (const state of states) {
    for (const spec of SERIES_PER_STATE) {
      const id = lausSeriesId(state.fips, spec.measure);
      seriesMeta.set(id, { fips: state.fips, abbr: state.abbr, kind: spec.kind });
    }
  }

  const allIds = [...seriesMeta.keys()];
  const errors: BlsFetchAllResult['errors'] = [];
  const perStateIndicators: BlsFetchAllResult['perStateIndicators'] = new Map();

  const BATCH = 25;
  for (let i = 0; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    try {
      const data = await fetchBlsBatch({
        apiKey: opts.apiKey,
        seriesIds: batch,
        startYear,
        endYear,
        signal: opts.signal,
      });
      for (const series of data.Results?.series ?? []) {
        const meta = seriesMeta.get(series.seriesID);
        if (!meta) continue;
        const latest = series.data[0]; // BLS returns descending
        if (!latest || latest.value === '-') continue;
        const numeric = Number(latest.value);
        if (!Number.isFinite(numeric)) continue;
        const date = periodToIso(latest.year, latest.period);
        if (!date) continue;
        const obs: IndicatorObservation = {
          value: numeric,
          observation_date: date,
          source: `BLS:${series.seriesID}`,
          fetched_at: now.toISOString(),
        };
        let bucket = perStateIndicators.get(meta.fips);
        if (!bucket) {
          bucket = {};
          perStateIndicators.set(meta.fips, bucket);
        }
        bucket[meta.kind] = obs;
      }
    } catch (err) {
      for (const id of batch) {
        const meta = seriesMeta.get(id);
        errors.push({
          state_abbr: meta?.abbr ?? '?',
          series_id: id,
          error: String(err),
        });
      }
    }
  }

  return { perStateIndicators, errors };
}

/**
 * Convenience helper: fold BLS observations into the existing per-state
 * snapshot map (FRED + BEA + Census all merge through the same path).
 */
export function mergeBlsIntoSnapshots(
  snapshots: StateSnapshot[],
  bls: BlsFetchAllResult,
): StateSnapshot[] {
  return snapshots.map((snap) => {
    const blsForState = bls.perStateIndicators.get(snap.state_fips);
    if (!blsForState) return snap;
    return {
      ...snap,
      indicators: { ...snap.indicators, ...blsForState },
      refreshed_at: new Date().toISOString(),
    };
  });
}
