/**
 * Data plane entry point.
 *
 * Pulls per-state economic indicators from FRED, BLS, BEA, Census plus
 * active NOAA shock events. In-memory + disk cache. Agents poll their
 * own state's snapshot every tick — they never call the upstreams
 * directly so rate limits are shared across the whole mesh.
 *
 * Endpoints:
 *   GET /healthz                  basic liveness + per-source last refresh
 *   GET /snapshot/:fips           cached economic snapshot for a state
 *   GET /snapshots                list of all cached snapshots (debug)
 *   GET /shocks                   top-N severity-sorted active shocks
 *   GET /shocks/state/:fips       active shocks affecting a specific state
 *   POST /refresh                 force-refresh all sources (auth-gated)
 */

import { resolve } from 'node:path';
import { type DataPlaneHealth, STATES, lookupStateByFips } from '@federated-reserve/shared';
import { SnapshotCache } from './cache.ts';
import { type SchedulerKeys, RefreshScheduler } from './scheduler.ts';
import { ShockCache } from './shock-cache.ts';

function readNumberEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} not numeric: ${v}`);
  return n;
}

const PORT = readNumberEnv('DATA_PLANE_PORT', 3002);
const REFRESH_MS = readNumberEnv('DATA_PLANE_REFRESH_MS', 60 * 60 * 1000); // 1h
const CACHE_PATH = resolve(
  process.env.DATA_PLANE_CACHE_PATH ?? resolve(process.cwd(), '../../.data/data-plane-cache.json'),
);
const SHOCK_CACHE_PATH = resolve(
  process.env.DATA_PLANE_SHOCK_CACHE_PATH ?? resolve(process.cwd(), '../../.data/shocks-cache.json'),
);
const REFRESH_TOKEN = process.env.DATA_PLANE_REFRESH_TOKEN;

const keys: SchedulerKeys = {
  fred: process.env.FRED_API_KEY,
  bls: process.env.BLS_API_KEY,
  bea: process.env.BEA_API_KEY,
  census: process.env.CENSUS_API_KEY,
};

function keyOk(k: string | undefined): boolean {
  return Boolean(k && !k.startsWith('PLACEHOLDER') && k.length > 4);
}

const sourcesEnabled: string[] = [];
if (keyOk(keys.fred)) sourcesEnabled.push('fred');
if (keyOk(keys.bls)) sourcesEnabled.push('bls');
if (keyOk(keys.bea)) sourcesEnabled.push('bea');
if (keyOk(keys.census)) sourcesEnabled.push('census');
sourcesEnabled.push('noaa'); // no key required

console.log(`[data-plane] sources enabled: ${sourcesEnabled.join(', ')}`);
for (const src of ['FRED', 'BLS', 'BEA', 'CENSUS']) {
  if (!keyOk(process.env[`${src}_API_KEY`])) {
    console.warn(
      `[data-plane] ${src}_API_KEY missing or placeholder — that source will be skipped on refresh`,
    );
  }
}

const cache = new SnapshotCache(CACHE_PATH);
await cache.hydrate();

const shockCache = new ShockCache(SHOCK_CACHE_PATH);
await shockCache.hydrate();

const scheduler = new RefreshScheduler({
  keys,
  cache,
  shockCache,
  intervalMs: REFRESH_MS,
});
scheduler.start();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      const sched = scheduler.health();
      const health: DataPlaneHealth = {
        ok: true,
        states_loaded: cache.size(),
        states_total: STATES.length,
        last_refresh_at: sched.last_refresh_at,
        upstream_failures_last_hour: sched.upstream_failures_last_hour,
        sources: sched.sources,
        shocks_loaded: shockCache.size(),
      };
      return jsonResponse(health);
    }

    if (url.pathname === '/snapshots' && req.method === 'GET') {
      return jsonResponse({ snapshots: cache.list() });
    }

    if (url.pathname.startsWith('/snapshot/') && req.method === 'GET') {
      const fipsRaw = url.pathname.slice('/snapshot/'.length);
      const fips = Number(fipsRaw);
      if (!Number.isFinite(fips) || !lookupStateByFips(fips)) {
        return jsonResponse({ error: `unknown FIPS code: ${fipsRaw}` }, 400);
      }
      const snap = cache.get(fips);
      if (!snap) {
        return jsonResponse(
          { error: `no snapshot for FIPS ${fips} yet — refresh in progress?` },
          404,
        );
      }
      return jsonResponse(snap);
    }

    if (url.pathname === '/shocks' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      return jsonResponse({ events: shockCache.topSevere(limit) });
    }

    if (url.pathname.startsWith('/shocks/state/') && req.method === 'GET') {
      const fipsRaw = url.pathname.slice('/shocks/state/'.length);
      const fips = Number(fipsRaw);
      if (!Number.isFinite(fips) || !lookupStateByFips(fips)) {
        return jsonResponse({ error: `unknown FIPS code: ${fipsRaw}` }, 400);
      }
      const limit = Number(url.searchParams.get('limit') ?? '10');
      return jsonResponse({ state_fips: fips, events: shockCache.forState(fips, limit) });
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      if (REFRESH_TOKEN) {
        const auth = req.headers.get('authorization') ?? '';
        if (auth !== `Bearer ${REFRESH_TOKEN}`) {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
      }
      void scheduler.refreshOnce();
      return jsonResponse({ accepted: true });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(
  `[data-plane] listening on http://127.0.0.1:${server.port}  ` +
    `(refresh ${REFRESH_MS / 1000}s, snapshot=${CACHE_PATH}, shocks=${SHOCK_CACHE_PATH})`,
);

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[data-plane] received ${sig}, shutting down`);
  scheduler.stop();
  server.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
