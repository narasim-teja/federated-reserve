/**
 * Agent entry point.
 *
 * Startup ordering (validated in Phase 0 spike-02):
 *   1. AXL node (sidecar — assumed already up; we just probe /topology)
 *   2. MCP Router (sidecar — wait for /health)
 *   3. Local TS MCP server (Bun.serve)
 *   4. Register MCP server with Router
 *   5. Local TS A2A server (Bun.serve)
 *   6. Tick loop
 *
 * Shutdown reverses: stop tick → stop A2A → deregister + stop MCP → done.
 * AXL and Router are sidecars and outlive the agent.
 */

import { describeAgent, loadConfig } from './config.ts';
import { AxlClient } from './axl-client.ts';
import { McpRouterClient } from './mcp-router-client.ts';
import { MeshDiscovery } from './discovery.ts';
import { makeMcpRequestHandler } from './mcp/server.ts';
import { startA2aServer } from './a2a/server.ts';
import { makeInitialState } from './state.ts';
import { startTickLoop } from './tick.ts';

const cfg = loadConfig();
const state = makeInitialState(cfg.state.fips);
const axl = new AxlClient(cfg.axl.apiUrl);
const router = new McpRouterClient(cfg.mcp.routerUrl);
const discovery = new MeshDiscovery(cfg, axl);

console.log(`[${cfg.state.abbr}] starting agent: ${describeAgent(cfg)}`);
console.log(
  `[${cfg.state.abbr}]   AXL=${cfg.axl.apiUrl}  router=${cfg.mcp.routerUrl}  ` +
    `mcp=:${cfg.mcp.serverPort}  a2a=:${cfg.a2a.serverPort}`,
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

// 3. Start MCP server.
const handleMcp = makeMcpRequestHandler({ cfg, state, axl, discovery });
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

// 4. Register with the Router.
await router.register({
  service: cfg.mcp.serviceName,
  endpoint: cfg.mcp.serverEndpoint,
});
console.log(
  `[${cfg.state.abbr}]   Registered "${cfg.mcp.serviceName}" with router at ${cfg.mcp.routerUrl}`,
);

// 5. Start A2A server.
const a2a = startA2aServer(cfg, state);

// 6. Start the gossip discovery loop. First refresh fires in 2s (after our
//    own MCP server is up so peers querying us back get a real response);
//    subsequent refreshes every 10s. Phase 2 may dial this up/down.
discovery.start(10_000);

// 7. Start tick loop.
const tick = startTickLoop(cfg, axl, discovery);

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
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
