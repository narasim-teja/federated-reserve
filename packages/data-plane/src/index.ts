/**
 * Data plane entry point.
 *
 * Single Bun.serve service. Pulls per-state economic indicators from FRED on
 * a fixed cadence, caches them in memory + on disk, and serves them to
 * agents over HTTP. Agents poll their own state's snapshot every tick — they
 * never call FRED directly, so the upstream rate limit is shared across the
 * whole mesh.
 *
 * Endpoints:
 *   GET /healthz         basic liveness + last refresh metadata
 *   GET /snapshot/:fips  cached snapshot for a state (404 if not loaded yet)
 *   GET /snapshots       list of all cached snapshots (debug)
 *   POST /refresh        force-refresh all states (auth-gated by token)
 */

import { resolve } from 'node:path';
import { type DataPlaneHealth, STATES, lookupStateByFips } from '@federated-reserve/shared';
import { SnapshotCache } from './cache.ts';
import { RefreshScheduler } from './scheduler.ts';

function readNumberEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} not numeric: ${v}`);
  return n;
}

const FRED_API_KEY = process.env.FRED_API_KEY;
if (!FRED_API_KEY || FRED_API_KEY === 'PLACEHOLDER_32_HEX') {
  console.error(
    '[data-plane] FRED_API_KEY missing or placeholder; data plane will start but refresh will fail.\n' +
      '  Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html and put it in .env.local.',
  );
}

const PORT = readNumberEnv('DATA_PLANE_PORT', 3002);
const REFRESH_MS = readNumberEnv('DATA_PLANE_REFRESH_MS', 60 * 60 * 1000); // 1h
const CACHE_PATH = resolve(
  process.env.DATA_PLANE_CACHE_PATH ?? resolve(process.cwd(), '../../.data/data-plane-cache.json'),
);
const REFRESH_TOKEN = process.env.DATA_PLANE_REFRESH_TOKEN;

const cache = new SnapshotCache(CACHE_PATH);
await cache.hydrate();

const scheduler = new RefreshScheduler({
  apiKey: FRED_API_KEY ?? 'MISSING',
  cache,
  intervalMs: REFRESH_MS,
});

if (FRED_API_KEY && FRED_API_KEY !== 'PLACEHOLDER_32_HEX') {
  scheduler.start();
} else {
  console.warn('[data-plane] scheduler not started — set FRED_API_KEY to enable refreshes');
}

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
    `(refresh interval ${REFRESH_MS / 1000}s, cache ${CACHE_PATH})`,
);

// Graceful shutdown.
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
