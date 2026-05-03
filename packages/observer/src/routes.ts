/**
 * HTTP routes wired onto the observer's Hono app. Split out so `index.ts`
 * stays focused on lifecycle (boot, MCP server, WS server, shutdown).
 *
 * Two surfaces here:
 *
 *  - **Read-only views** of mesh state (mode-2/4 dossier reads, fed history,
 *    negotiation lookup) that read off the disk-hydrated `ObserverStore`.
 *
 *  - **Telemetry ingestion** (`POST /events/...`) used by the per-agent
 *    executor to push negotiation rounds, swap settlements, NOAA shock
 *    injections, and reflections — i.e. anything the broadcast-tier MCP
 *    fabric does not already give the observer for free.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  STATES,
  assessCredit,
  getPersona,
  lookupStateByAbbr,
  lookupStateByFips,
} from '@federated-reserve/shared';
import type { Hono } from 'hono';
import type { ObserverStore } from './store.ts';
import type {
  NegotiationRoundPayload,
  ReflectionPayload,
  ShockInjectedPayload,
  SwapExecutedPayload,
} from './types.ts';

interface MountOptions {
  app: Hono;
  store: ObserverStore;
  memoryRoot: string;
}

const AGENT_LOG_LIMIT_DEFAULT = 50;
const AGENT_LOG_LIMIT_MAX = 500;

export function mountRoutes({ app, store, memoryRoot }: MountOptions): void {
  // ---------- Per-agent dossier reads (Mode 2) -------------------------
  app.get('/agent/:abbr', async (c) => {
    const abbr = c.req.param('abbr').toUpperCase();
    const meta = lookupStateByAbbr(abbr);
    if (!meta) return c.json({ error: `unknown state abbr: ${abbr}` }, 404);

    const dirKey = abbr.toLowerCase();
    const stateFile = join(memoryRoot, dirKey, 'state.json');
    const logFile = join(memoryRoot, dirKey, 'log.jsonl');

    const persona = getPersona(abbr);
    const snapshot = store.snapshot();
    const stateView = snapshot.states.find((s) => s.abbr === abbr) ?? null;
    const inft = snapshot.infts.find((e) => e.state_abbr === abbr) ?? null;

    const memoryState = await readJson(stateFile);
    const credit = stateView
      ? assessCredit(abbr, {
          reserveRatio: stateView.reserve_ratio ?? 0,
          unemploymentPct: stateView.indicators?.unemployment?.value ?? null,
          personalIncomeUsd: null,
          region: meta.region,
        })
      : null;

    const negotiations = store
      .negotiationSnapshot()
      .filter((n) => n.participants.includes(meta.fips))
      .slice(0, 8);

    const swaps = store
      .swapHistorySnapshot()
      .filter((s) => s.from_fips === meta.fips || s.to_fips === meta.fips)
      .slice(0, 12);

    return c.json({
      meta: {
        fips: meta.fips,
        abbr: meta.abbr,
        name: meta.name,
        region: meta.region,
        tier: meta.tier,
      },
      persona: {
        tagline: persona.tagline,
        posture: persona.posture,
        coalitions: [...persona.coalitions],
      },
      live: stateView,
      memory: memoryState,
      credit,
      inft,
      negotiations,
      swaps,
      reflections: store
        .reflectionsSnapshot()
        .filter((r) => r.state_fips === meta.fips)
        .slice(0, 6),
      latest_reflection:
        store.reflectionsSnapshot().find((r) => r.state_fips === meta.fips) ?? null,
    });
  });

  app.get('/agent/:abbr/log', async (c) => {
    const abbr = c.req.param('abbr').toUpperCase();
    const meta = lookupStateByAbbr(abbr);
    if (!meta) return c.json({ error: `unknown state abbr: ${abbr}` }, 404);
    const limit = clamp(
      Number(c.req.query('limit') ?? AGENT_LOG_LIMIT_DEFAULT),
      1,
      AGENT_LOG_LIMIT_MAX,
    );
    const file = join(memoryRoot, abbr.toLowerCase(), 'log.jsonl');
    if (!existsSync(file)) return c.json({ entries: [] });
    const raw = await readFile(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit).reverse();
    const entries: unknown[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return c.json({ entries });
  });

  app.get('/agent/:abbr/card', async (c) => {
    const abbr = c.req.param('abbr').toUpperCase();
    const meta = lookupStateByAbbr(abbr);
    if (!meta) return c.json({ error: `unknown state abbr: ${abbr}` }, 404);
    const persona = getPersona(abbr);
    return c.json({
      protocolVersion: '0.3.0',
      name: `${meta.name} State Treasurer`,
      description: persona.tagline,
      coalitions: [...persona.coalitions],
      posture: persona.posture,
      capabilities: { streaming: true, stateTransitionHistory: true },
      skills: [
        { id: 'negotiate-bilateral-swap', name: 'Bilateral Swap Negotiation' },
        { id: 'participate-in-coalition', name: 'Coalition Participation' },
        { id: 'bond-auction', name: 'Bond Auction' },
        { id: 'request-emergency-aid', name: 'Emergency Aid' },
        { id: 'coordinate-shock-response', name: 'Shock Response Coordination' },
      ],
    });
  });

  app.get('/agents', (c) =>
    c.json({
      agents: STATES.map((s) => ({
        fips: s.fips,
        abbr: s.abbr,
        name: s.name,
        region: s.region,
        tier: s.tier,
      })),
    }),
  );

  // ---------- Federal reserve view (Mode 4) ----------------------------
  app.get('/fed/rate-history', (c) =>
    c.json({ entries: store.fedRateHistorySnapshot() }),
  );

  // ---------- Negotiations (Mode 3) ------------------------------------
  app.get('/negotiations', (c) => c.json({ entries: store.negotiationSnapshot() }));
  app.get('/negotiations/:taskId', (c) => {
    const view = store.negotiation(c.req.param('taskId'));
    if (!view) return c.json({ error: 'not found' }, 404);
    return c.json(view);
  });

  // ---------- Swap history (capital-flow arcs) -------------------------
  app.get('/swaps', (c) => c.json({ entries: store.swapHistorySnapshot() }));

  // ---------- Active NOAA shocks --------------------------------------
  app.get('/shocks', (c) => c.json({ entries: store.shockSnapshot() }));

  // ---------- Onchain views (Phase 5) ---------------------------------
  app.get('/onchain', (c) => {
    const snapshot = store.snapshot();
    const entries = snapshot.states
      .filter((s) => s.wallet_address || s.chain_balances)
      .map((s) => ({
        fips: s.fips,
        abbr: s.abbr,
        name: s.name,
        wallet_address: s.wallet_address,
        chain_balances: s.chain_balances,
        og_status: s.og_status,
      }));
    return c.json({ entries });
  });

  app.get('/onchain/:abbr', (c) => {
    const abbr = c.req.param('abbr').toUpperCase();
    const snapshot = store.snapshot();
    const view = snapshot.states.find((s) => s.abbr === abbr);
    if (!view) return c.json({ error: `unknown state abbr: ${abbr}` }, 404);
    return c.json({
      fips: view.fips,
      abbr: view.abbr,
      name: view.name,
      wallet_address: view.wallet_address,
      chain_balances: view.chain_balances,
      og_status: view.og_status,
    });
  });

  // ---------- Reflections ticker --------------------------------------
  app.get('/reflections', (c) => c.json({ entries: store.reflectionsSnapshot() }));

  // ---------- Telemetry ingestion (called by agent executors) ---------
  app.post('/events/negotiation-round', async (c) => {
    const body = await safeJson<NegotiationRoundPayload>(c);
    if (!body || typeof body.task_id !== 'string' || typeof body.from_fips !== 'number') {
      return c.json({ error: 'invalid negotiation_round payload' }, 400);
    }
    if (body.to_fips != null && !lookupStateByFips(body.to_fips)) body.to_fips = null;
    store.ingestNegotiationRound({
      ...body,
      emitted_at: body.emitted_at ?? new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post('/events/swap-executed', async (c) => {
    const body = await safeJson<SwapExecutedPayload>(c);
    if (
      !body ||
      typeof body.from_fips !== 'number' ||
      typeof body.to_fips !== 'number' ||
      !body.tx_hash
    ) {
      return c.json({ error: 'invalid swap_executed payload' }, 400);
    }
    store.ingestSwapExecuted({
      ...body,
      emitted_at: body.emitted_at ?? new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post('/events/shock-injected', async (c) => {
    const body = await safeJson<ShockInjectedPayload>(c);
    if (
      !body ||
      typeof body.state_fips !== 'number' ||
      typeof body.severity !== 'number' ||
      !body.event_type
    ) {
      return c.json({ error: 'invalid shock_injected payload' }, 400);
    }
    store.ingestShockInjected({
      ...body,
      emitted_at: body.emitted_at ?? new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  app.post('/events/reflection', async (c) => {
    const body = await safeJson<ReflectionPayload>(c);
    if (!body || typeof body.state_fips !== 'number' || !body.summary) {
      return c.json({ error: 'invalid reflection payload' }, 400);
    }
    const meta = lookupStateByFips(body.state_fips);
    store.ingestReflection({
      state_fips: body.state_fips,
      state_abbr: meta?.abbr ?? body.state_abbr ?? `FIPS${body.state_fips}`,
      summary: body.summary,
      tick: body.tick ?? null,
      emitted_at: body.emitted_at ?? new Date().toISOString(),
    });
    return c.json({ ok: true });
  });
}

async function readJson<T = unknown>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function safeJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
