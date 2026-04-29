/**
 * Agent entry point.
 *
 * Phase 2 startup ordering (Phase 1 baseline + memory + data-plane + reasoner):
 *   1. AXL node (sidecar — assumed already up; we just probe /topology)
 *   2. MCP Router (sidecar — wait for /health)
 *   3. AgentMemory (load prior state from disk if any)
 *   4. Reasoner (lazy — instantiated only if reasoning enabled)
 *   5. DataPlaneClient (logs an unreachable warning at startup; tolerable)
 *   6. Local TS MCP server (Bun.serve)
 *   7. Register MCP server with Router
 *   8. Local TS A2A server (Bun.serve)
 *   9. MeshDiscovery (1-hop gossip refresh loop)
 *  10. Tick loop
 *
 * Shutdown reverses: stop tick → discovery → A2A → deregister + stop MCP →
 * persist final state → done. AXL and Router outlive the agent.
 */

import { getPersona } from '@federated-reserve/shared';
import { startA2aServer } from './a2a/server.ts';
import { AxlClient } from './axl-client.ts';
import { describeAgent, loadConfig } from './config.ts';
import { DataPlaneClient } from './data-plane-client.ts';
import { MeshDiscovery } from './discovery.ts';
import { SwapExecutor } from './execute.ts';
import { McpRouterClient } from './mcp-router-client.ts';
import { makeMcpRequestHandler } from './mcp/server.ts';
import { makeMemory } from './memory.ts';
import { type Reasoner, getReasoner } from './reason.ts';
import { makeInitialState } from './state.ts';
import { buildAgentSystemPrompt } from './system-prompts.ts';
import { startTickLoop } from './tick.ts';

const cfg = loadConfig();
const persona = getPersona(cfg.state.abbr);
const systemPrompt = buildAgentSystemPrompt(cfg.state, persona);
const memory = makeMemory({ agentKey: cfg.state.abbr.toLowerCase() });

// Hydrate state from prior run if present.
const persisted = await memory.loadState();
const state = persisted ?? makeInitialState(cfg.state.fips);
if (persisted) {
  console.log(`[${cfg.state.abbr}] resumed from ${memory.describe()}: tick=${persisted.tickCount}`);
}

const axl = new AxlClient(cfg.axl.apiUrl);
const router = new McpRouterClient(cfg.mcp.routerUrl);
const discovery = new MeshDiscovery(cfg, axl);
const dataPlane = new DataPlaneClient(cfg.dataPlaneUrl);

let reasoner: Reasoner | undefined;
if (cfg.reasoningEnabled) {
  try {
    reasoner = getReasoner();
    console.log(`[${cfg.state.abbr}] OpenRouter reasoner ready (preset tier: ${cfg.state.tier})`);
  } catch (err) {
    console.warn(
      `[${cfg.state.abbr}] OpenRouter init failed (${String(err)}); falling back to deterministic logic`,
    );
  }
} else {
  console.log(`[${cfg.state.abbr}] OpenRouter disabled — using deterministic fallback paths`);
}

let swapExecutor: SwapExecutor | undefined;
if (cfg.settlement.enabled && cfg.settlement.walletPrivateKey) {
  try {
    swapExecutor = new SwapExecutor({
      privateKey: cfg.settlement.walletPrivateKey,
      apiKey: cfg.settlement.uniswapApiKey,
      chainId: cfg.settlement.chainId,
      rpc: cfg.settlement.rpc,
    });
    console.log(
      `[${cfg.state.abbr}] settlement wired: ${swapExecutor.address} on chain ${cfg.settlement.chainId}`,
    );
  } catch (err) {
    console.warn(
      `[${cfg.state.abbr}] SwapExecutor init failed (${String(err)}); negotiations will complete without onchain legs`,
    );
  }
} else {
  console.log(
    `[${cfg.state.abbr}] settlement disabled — negotiations complete with legs.responder=null`,
  );
}

console.log(`[${cfg.state.abbr}] starting agent: ${describeAgent(cfg)}`);
console.log(
  `[${cfg.state.abbr}]   AXL=${cfg.axl.apiUrl}  router=${cfg.mcp.routerUrl}  ` +
    `mcp=:${cfg.mcp.serverPort}  a2a=:${cfg.a2a.serverPort}  data=${cfg.dataPlaneUrl}`,
);

// 1. Probe AXL /topology so we fail fast if the sidecar isn't up.
{
  const topology = await axl.topology();
  console.log(
    `[${cfg.state.abbr}]   AXL up — our pubkey: ${topology.our_public_key.slice(0, 12)}…  ` +
      `peers: ${topology.peers.length}`,
  );
}

// 2. Wait for MCP Router.
await router.waitReady();
console.log(`[${cfg.state.abbr}]   MCP Router ready`);

// 3. Probe data plane (best-effort — tolerated if not up yet).
{
  const health = await dataPlane.healthz();
  if (health) {
    console.log(
      `[${cfg.state.abbr}]   data plane up — ${health.states_loaded}/${health.states_total} states loaded`,
    );
  } else {
    console.warn(
      `[${cfg.state.abbr}]   data plane unreachable at ${cfg.dataPlaneUrl} — ticks will skip broadcasts`,
    );
  }
}

// 4. Start MCP server.
const handleMcp = makeMcpRequestHandler({ cfg, state, axl, discovery, swapExecutor });
const mcpServer = Bun.serve({
  port: cfg.mcp.serverPort,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });
    return handleMcp(req);
  },
});
console.log(`[${cfg.state.abbr}]   MCP server listening on ${cfg.mcp.serverEndpoint}`);

// 5. Register with the Router.
await router.register({
  service: cfg.mcp.serviceName,
  endpoint: cfg.mcp.serverEndpoint,
});
console.log(
  `[${cfg.state.abbr}]   Registered "${cfg.mcp.serviceName}" with router at ${cfg.mcp.routerUrl}`,
);

// 6. Start A2A server (now reasoner-aware + Phase 3 swap-executor-aware).
const a2a = startA2aServer(cfg, state, reasoner, systemPrompt, swapExecutor);

// 7. Discovery loop.
discovery.start(10_000);

// 8. Tick loop.
const tick = startTickLoop({
  cfg,
  axl,
  discovery,
  dataPlane,
  memory,
  state,
  reasoner,
  systemPrompt,
});

// Persist initial state immediately so the file exists.
await memory.saveState(state);

console.log(`[${cfg.state.abbr}] ✓ agent ready`);

// ---------- Shutdown ------------------------------------------------------

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${cfg.state.abbr}] received ${sig}, shutting down...`);
  tick.stop();
  discovery.stop();
  a2a.stop();
  await router.deregister(cfg.mcp.serviceName);
  mcpServer.stop();
  await memory.saveState(state).catch((err: unknown) => {
    console.warn(`[${cfg.state.abbr}] final state save failed: ${String(err)}`);
  });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
