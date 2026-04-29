/**
 * BEA Regional ingestion.
 *
 * Pulls quarterly state-level Real GDP and total state Personal Income
 * from the BEA Regional dataset:
 *   - Regional dataset SAGDP9N: Real GDP by state (quarterly, $M chained 2017)
 *     LineCode 1 (All industry total).
 *   - Regional dataset SAINC1: Personal Income by state (quarterly, $M).
 *     LineCode 1 (Personal income).
 *
 * BEA distinguishes states by their numeric `GeoFips` — same as US Census
 * FIPS. National = `00000`; states = e.g. `25000` for MA, `06000` for CA.
 *
 * Endpoint:
 *   https://apps.bea.gov/api/data
 *     ?UserID=<key>&method=GetData&datasetname=Regional
 *     &TableName=SAGDP9N&LineCode=1
 *     &GeoFips=STATE&Year=LAST5&ResultFormat=JSON
 *
 * Quarterly Period values look like `2024Q3`. We surface the most recent
 * available value per state as `gdp_quarterly` (real, chained $M) and a
 * year-over-year `gdp_growth` (%) computed from the prior-year-Q.
 */

import {
  type EconomicIndicatorKind,
  type IndicatorObservation,
  STATES,
  type StateInfo,
} from '@federated-reserve/shared';
import { z } from 'zod';
import { TokenBucket } from '../rate-limit.ts';

// BEA documentation: 100 req/min per IP, no daily cap. Stay well under.
const BEA_RATE_LIMITER = new TokenBucket({ ratePerSec: 1.5 });

const BEA_BASE = 'https://apps.bea.gov/api/data';

const beaDatumSchema = z
  .object({
    GeoFips: z.string(),
    GeoName: z.string().optional(),
    Code: z.string().optional(),
    TimePeriod: z.string(), // "2024Q3" or "2024" depending on table
    DataValue: z.string(), // numeric or "(NA)" / "(D)"
    UNIT_MULT: z.string().optional(),
    CL_UNIT: z.string().optional(),
  })
  .passthrough();

const beaResultsSchema = z
  .object({
    BEAAPI: z
      .object({
        Results: z
          .object({
            Data: z.array(beaDatumSchema).optional(),
            Error: z
              .object({ APIErrorCode: z.string(), APIErrorDescription: z.string() })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type BeaTable = 'SAGDP9N' | 'SAINC1';

interface BeaTableSpec {
  table: BeaTable;
  lineCode: number;
  /** Frequency hint for picking the latest period. */
  freq: 'A' | 'Q';
  /** Indicator kind we map this table+lineCode to. */
  kind: EconomicIndicatorKind;
  /** A second derived indicator if we compute YoY growth from this series. */
  yoyKind?: EconomicIndicatorKind;
}

const TABLE_SPECS: readonly BeaTableSpec[] = [
  // Real GDP by state, quarterly, all industries (LineCode 1, SAGDP9N).
  { table: 'SAGDP9N', lineCode: 1, freq: 'Q', kind: 'gdp_quarterly', yoyKind: 'gdp_growth' },
  // Personal income, quarterly, $M (SAINC1 LineCode 1 = "Personal income").
  { table: 'SAINC1', lineCode: 1, freq: 'Q', kind: 'personal_income_total' },
];

const RETRY_DELAYS_MS = [1500, 4000, 9000] as const;

interface BeaCallOptions {
  apiKey: string;
  spec: BeaTableSpec;
  signal?: AbortSignal;
}

async function callBeaTable(opts: BeaCallOptions): Promise<z.infer<typeof beaResultsSchema>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await BEA_RATE_LIMITER.acquire();
    const url = new URL(BEA_BASE);
    url.searchParams.set('UserID', opts.apiKey);
    url.searchParams.set('method', 'GetData');
    url.searchParams.set('datasetname', 'Regional');
    url.searchParams.set('TableName', opts.spec.table);
    url.searchParams.set('LineCode', String(opts.spec.lineCode));
    url.searchParams.set('GeoFips', 'STATE');
    url.searchParams.set('Year', 'LAST5');
    if (opts.spec.freq === 'Q') {
      // Always Q1..Q4
      url.searchParams.set('Frequency', 'Q');
    }
    url.searchParams.set('ResultFormat', 'JSON');
    const res = await fetch(url, { signal: opts.signal });
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`BEA ${res.status}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`BEA ${res.status}: ${body}`);
    }
    const json = await res.json();
    const parsed = beaResultsSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`BEA bad response: ${parsed.error.message}`);
    }
    const apiErr = parsed.data.BEAAPI?.Results?.Error;
    if (apiErr) {
      throw new Error(`BEA API error ${apiErr.APIErrorCode}: ${apiErr.APIErrorDescription}`);
    }
    return parsed.data;
  }
  throw lastErr ?? new Error('BEA fetch failed');
}

function parseValue(raw: string): number | null {
  // BEA represents missing as "(NA)" / "(D)" / "(L)"; thousands separators present.
  if (!raw || raw.startsWith('(')) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function periodToIso(period: string): string | null {
  // "2024Q3" → "2024-07-01"; "2024" → "2024-01-01".
  const qMatch = /^(\d{4})Q([1-4])$/.exec(period);
  if (qMatch) {
    const [, year, q] = qMatch;
    const qNum = Number(q);
    const month = (qNum - 1) * 3 + 1;
    return `${year}-${String(month).padStart(2, '0')}-01`;
  }
  if (/^\d{4}$/.test(period)) return `${period}-01-01`;
  return null;
}

function fipsToGeoFips(fips: number): string {
  return String(fips).padStart(2, '0') + '000';
}

function geoFipsToFips(geo: string): number | null {
  // GeoFips for states is 2-digit FIPS + "000"
  if (!/^\d{5}$/.test(geo)) return null;
  return Number(geo.slice(0, 2));
}

export interface BeaFetchAllResult {
  perStateIndicators: Map<number, Partial<Record<EconomicIndicatorKind, IndicatorObservation>>>;
  errors: Array<{ state_abbr: string; table: string; error: string }>;
}

export async function fetchBeaRegional(opts: {
  apiKey: string;
  states?: readonly StateInfo[];
  signal?: AbortSignal;
}): Promise<BeaFetchAllResult> {
  const states = opts.states ?? STATES.filter((s) => s.fips < 100);
  const wantFips = new Set(states.map((s) => fipsToGeoFips(s.fips)));
  const errors: BeaFetchAllResult['errors'] = [];
  const perStateIndicators: BeaFetchAllResult['perStateIndicators'] = new Map();
  const now = new Date();

  for (const spec of TABLE_SPECS) {
    try {
      const data = await callBeaTable({ apiKey: opts.apiKey, spec, signal: opts.signal });
      const rows = data.BEAAPI?.Results?.Data ?? [];

      // Group rows by GeoFips → array; pick the latest non-null period.
      const byGeo = new Map<string, typeof rows>();
      for (const r of rows) {
        if (!wantFips.has(r.GeoFips)) continue;
        let arr = byGeo.get(r.GeoFips);
        if (!arr) {
          arr = [];
          byGeo.set(r.GeoFips, arr);
        }
        arr.push(r);
      }

      for (const [geo, geoRows] of byGeo) {
        const fips = geoFipsToFips(geo);
        if (fips === null) continue;
        // Sort by TimePeriod descending (e.g. 2024Q4, 2024Q3, ...)
        const sorted = [...geoRows].sort((a, b) => (a.TimePeriod < b.TimePeriod ? 1 : -1));
        const latest = sorted.find((r) => parseValue(r.DataValue) !== null);
        if (!latest) continue;
        const value = parseValue(latest.DataValue);
        if (value === null) continue;
        const date = periodToIso(latest.TimePeriod);
        if (!date) continue;
        const obs: IndicatorObservation = {
          value,
          observation_date: date,
          source: `BEA:${spec.table}#${spec.lineCode}@${latest.TimePeriod}`,
          fetched_at: now.toISOString(),
        };
        let bucket = perStateIndicators.get(fips);
        if (!bucket) {
          bucket = {};
          perStateIndicators.set(fips, bucket);
        }
        bucket[spec.kind] = obs;

        // YoY growth derived from same-quarter-prior-year if requested.
        if (spec.yoyKind) {
          const yoy = findPriorYearMatch(sorted, latest.TimePeriod);
          if (yoy !== null) {
            const prior = parseValue(yoy.DataValue);
            if (prior !== null && prior !== 0) {
              const pct = ((value - prior) / prior) * 100;
              bucket[spec.yoyKind] = {
                value: pct,
                observation_date: date,
                source: `BEA:${spec.table}#${spec.lineCode}@${latest.TimePeriod}/yoy`,
                fetched_at: now.toISOString(),
              };
            }
          }
        }
      }
    } catch (err) {
      for (const s of states) {
        errors.push({ state_abbr: s.abbr, table: spec.table, error: String(err) });
      }
    }
  }

  return { perStateIndicators, errors };
}

function findPriorYearMatch(
  rows: ReadonlyArray<{ TimePeriod: string; DataValue: string }>,
  current: string,
): { TimePeriod: string; DataValue: string } | null {
  const m = /^(\d{4})Q([1-4])$/.exec(current);
  if (m) {
    const [, year, q] = m;
    const target = `${Number(year) - 1}Q${q}`;
    return rows.find((r) => r.TimePeriod === target) ?? null;
  }
  const ym = /^(\d{4})$/.exec(current);
  if (ym) {
    const [, year] = ym;
    const target = `${Number(year) - 1}`;
    return rows.find((r) => r.TimePeriod === target) ?? null;
  }
  return null;
}
