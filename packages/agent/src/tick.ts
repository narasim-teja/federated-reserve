/**
 * Tick loop.
 *
 * Phase 2: each tick the agent
 *   1. polls its own state's snapshot from the data plane
 *   2. picks the freshest indicator and broadcasts it to the discovered mesh
 *   3. updates `state.ownSnapshot` and persists state to memory
 *   4. on every Nth tick, kicks off a reflection pass (handled by reflect.ts)
 *
 * If the data plane is unreachable or hasn't loaded our state's snapshot
 * yet, we skip the broadcast — the project's non-goals say "never fake data."
 */

import { type StateSnapshot, pickBroadcastIndicator } from '@federated-reserve/shared';
import type { AxlClient } from './axl-client.ts';
import { broadcastIndicator } from './broadcast.ts';
import type { AgentConfig } from './config.ts';
import type { DataPlaneClient } from './data-plane-client.ts';
import type { MeshDiscovery } from './discovery.ts';
import type { AgentMemory } from './memory.ts';
import type { Reasoner } from './reason.ts';
import { runReflection } from './reflect.ts';
import type { AgentState } from './state.ts';

export interface TickDeps {
  cfg: AgentConfig;
  axl: AxlClient;
  discovery: MeshDiscovery;
  dataPlane: DataPlaneClient;
  memory: AgentMemory;
  state: AgentState;
  reasoner?: Reasoner;
  /** System prompt baked at startup; passed to the reasoner on every call. */
  systemPrompt: string;
}

export function startTickLoop(deps: TickDeps): { stop: () => void } {
  const { cfg, state, memory, dataPlane } = deps;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    state.tickCount += 1;
    const tickNo = state.tickCount;

    try {
      const snapshot = await dataPlane.snapshot(cfg.state.fips);
      if (!snapshot) {
        console.log(
          `[${cfg.state.abbr}] tick ${tickNo}: no snapshot from data plane yet — skipping broadcast`,
        );
      } else {
        state.ownSnapshot = snapshot;
        await broadcastFromSnapshot(deps, snapshot, tickNo);
      }

      // Reflection cadence — log-based summary using OpenRouter (when enabled).
      if (tickNo % cfg.reflectEveryNTicks === 0) {
        await runReflection(deps).catch((err: unknown) => {
          console.warn(`[${cfg.state.abbr}] reflection failed: ${String(err)}`);
        });
      }

      // Persist state after the tick (snapshot + tickCount changed).
      await memory.saveState(state);
    } catch (err) {
      console.error(`[${cfg.state.abbr}] tick ${tickNo} failed:`, err);
    } finally {
      if (!stopped) timer = setTimeout(tick, cfg.tickIntervalMs);
    }
  };

  // First tick fires after a short delay so peers have time to discover us.
  timer = setTimeout(tick, 5_000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function broadcastFromSnapshot(
  deps: TickDeps,
  snapshot: StateSnapshot,
  tickNo: number,
): Promise<void> {
  const { cfg, axl, discovery, memory } = deps;
  const picked = pickBroadcastIndicator(snapshot);
  if (!picked) {
    console.log(
      `[${cfg.state.abbr}] tick ${tickNo}: snapshot has no indicators yet — skipping broadcast`,
    );
    return;
  }
  const input = {
    state_fips: cfg.state.fips,
    indicator: picked.kind,
    value: picked.obs.value,
    timestamp: picked.obs.observation_date,
    source: picked.obs.source,
  };
  const results = await broadcastIndicator(cfg, axl, discovery, input);
  const ok = results.filter((r) => r.ok).length;
  await memory.appendLog({
    kind: 'broadcast_sent',
    at: new Date().toISOString(),
    summary: `${picked.kind}=${picked.obs.value} from ${picked.obs.source} → ${ok}/${results.length} peers`,
    details: { tick: tickNo, input, results },
  });
}
