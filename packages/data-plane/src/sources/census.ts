/**
 * US Census ACS 5-year ingestion.
 *
 * Pulls demographic baselines per state. ACS 5-year is the right cadence
 * for Census data — refreshes annually but the values change slowly. We
 * pull on every data-plane refresh for simplicity; a stale cache here
 * doesn't matter (it's the floor of state structure, not a tactical
 * indicator).
 *
 * Variables (from the ACS 5-year subject tables):
 *   B01003_001E  Total population
 *   B19013_001E  Median household income (USD/year)
 *   B17001_002E  Population for whom poverty status is determined: Income below
 *                poverty level — combined with B17001_001E (universe) to derive
 *                poverty rate as a percentage.
 *
 * Endpoint:
 *   https://api.census.gov/data/2022/acs/acs5
 *     ?get=NAME,B01003_001E,B19013_001E,B17001_001E,B17001_002E
 *     &for=state:*
 *     &key=<key>
 *
 * Returns a 2D array — first row is column headers, subsequent rows are
 * one per state.
 */

import {
  type EconomicIndicatorKind,
  type IndicatorObservation,
  STATES,
  type StateInfo,
} from '@federated-reserve/shared';
import { TokenBucket } from '../rate-limit.ts';

const CENSUS_RATE_LIMITER = new TokenBucket({ ratePerSec: 2 });

// Use a known-good ACS 5-year vintage. Census typically lags ~1 year so 2023 is current.
const CENSUS_BASE = 'https://api.census.gov/data/2023/acs/acs5';

interface CensusVariable {
  /** ACS variable code, e.g. B01003_001E. */
  code: string;
  kind: EconomicIndicatorKind | null;
  /** Optional transform from raw value to indicator value. */
  transform?: (raw: number, allColumns: Record<string, number>) => number | null;
}

const VARS: readonly CensusVariable[] = [
  { code: 'B01003_001E', kind: 'population' },
  { code: 'B19013_001E', kind: 'median_household_income' },
  { code: 'B17001_001E', kind: null }, // poverty universe — used by next row
  {
    code: 'B17001_002E',
    kind: 'poverty_rate',
    transform: (raw, all) => {
      const universe = all.B17001_001E;
      if (!universe || !Number.isFinite(universe) || universe === 0) return null;
      return (raw / universe) * 100; // percentage
    },
  },
];

const RETRY_DELAYS_MS = [1500, 4000, 9000] as const;

export interface CensusFetchAllResult {
  perStateIndicators: Map<number, Partial<Record<EconomicIndicatorKind, IndicatorObservation>>>;
  errors: Array<{ state_abbr: string; var: string; error: string }>;
}

export async function fetchCensusAcs(opts: {
  apiKey: string;
  states?: readonly StateInfo[];
  signal?: AbortSignal;
}): Promise<CensusFetchAllResult> {
  const states = opts.states ?? STATES.filter((s) => s.fips < 100);
  const fipsSet = new Set(states.map((s) => s.fips));
  const codes = VARS.map((v) => v.code).join(',');
  const errors: CensusFetchAllResult['errors'] = [];
  const perStateIndicators: CensusFetchAllResult['perStateIndicators'] = new Map();
  const now = new Date();

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await CENSUS_RATE_LIMITER.acquire();
    try {
      const url = new URL(CENSUS_BASE);
      url.searchParams.set('get', `NAME,${codes}`);
      url.searchParams.set('for', 'state:*');
      url.searchParams.set('key', opts.apiKey);
      const res = await fetch(url, { signal: opts.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Census ${res.status}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Census ${res.status}: ${body}`);
      }
      const text = await res.text();
      // Census responds with text/plain (a JSON array). Some 200 responses
      // are actually error pages with HTML — guard.
      let rows: string[][];
      try {
        rows = JSON.parse(text) as string[][];
      } catch {
        throw new Error(`Census non-JSON: ${text.slice(0, 200)}`);
      }
      if (!Array.isArray(rows) || rows.length < 2) {
        throw new Error('Census empty result');
      }
      const header = rows[0];
      if (!header) throw new Error('Census missing header row');
      const colIndex: Record<string, number> = {};
      header.forEach((name, i) => {
        colIndex[name] = i;
      });
      const stateCol = colIndex.state;
      if (stateCol === undefined) throw new Error("Census missing 'state' column");

      for (const row of rows.slice(1)) {
        const fips = Number(row[stateCol]);
        if (!Number.isFinite(fips) || !fipsSet.has(fips)) continue;
        const numerics: Record<string, number> = {};
        for (const v of VARS) {
          const idx = colIndex[v.code];
          if (idx === undefined) continue;
          const n = Number(row[idx]);
          if (Number.isFinite(n) && n >= 0) numerics[v.code] = n;
        }
        const indicators: Partial<Record<EconomicIndicatorKind, IndicatorObservation>> = {};
        for (const v of VARS) {
          if (!v.kind) continue;
          const raw = numerics[v.code];
          if (raw === undefined) continue;
          const value = v.transform ? v.transform(raw, numerics) : raw;
          if (value === null || !Number.isFinite(value)) continue;
          indicators[v.kind] = {
            value,
            observation_date: '2023-01-01', // ACS 5-year vintage anchor
            source: `Census:ACS5/2023/${v.code}`,
            fetched_at: now.toISOString(),
          };
        }
        if (Object.keys(indicators).length > 0) {
          perStateIndicators.set(fips, indicators);
        }
      }
      return { perStateIndicators, errors };
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        for (const s of states) {
          errors.push({ state_abbr: s.abbr, var: 'ACS5', error: String(err) });
        }
        return { perStateIndicators, errors };
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  return { perStateIndicators, errors };
}
