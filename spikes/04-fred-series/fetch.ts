/**
 * Spike 04 — FRED API state-level series fetch.
 *
 * Proves: with a free FRED API key, we can pull a state-level economic
 * series (here MA unemployment, FRED ID `MAUR`).
 *
 * Run: bun run spikes/04-fred-series/fetch.ts
 *
 * Env required:
 *   FRED_API_KEY    (free at https://fred.stlouisfed.org/docs/api/api_key.html)
 */

const API_KEY = process.env.FRED_API_KEY;

if (!API_KEY || API_KEY === 'PLACEHOLDER_32_HEX') {
  console.error('[spike-04] SKIP — FRED_API_KEY not set (placeholder).');
  console.error('  Get one (free, instant) at https://fred.stlouisfed.org/docs/api/api_key.html');
  process.exit(0);
}

const SERIES = 'MAUR'; // Massachusetts unemployment rate, monthly, %
const url = new URL('https://api.stlouisfed.org/fred/series/observations');
url.searchParams.set('series_id', SERIES);
url.searchParams.set('api_key', API_KEY);
url.searchParams.set('file_type', 'json');
url.searchParams.set('sort_order', 'desc');
url.searchParams.set('limit', '5');

console.log(`[spike-04] GET ${url.toString().replace(API_KEY, '***')}`);

const t0 = performance.now();
const res = await fetch(url);
const ms = (performance.now() - t0).toFixed(0);

console.log(`[spike-04] HTTP ${res.status} in ${ms}ms`);

if (!res.ok) {
  console.error(`[spike-04] FAIL: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const data = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
const obs = data.observations ?? [];
if (obs.length === 0) {
  console.error(`[spike-04] FAIL: empty observations for series ${SERIES}`);
  process.exit(1);
}

console.log(`[spike-04] PASS — got ${obs.length} latest observations for ${SERIES}:`);
for (const { date, value } of obs) {
  console.log(`  ${date}: ${value}%`);
}
