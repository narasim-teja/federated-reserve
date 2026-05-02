import {
  type AnnounceFedRateResult,
  MCP_TOOLS,
  type QueryTreasuryResult,
  type ShareEconomicIndicatorResult,
  type ShareTopologyResult,
  TREASURER_SERVICE_NAME,
  announceFedRateInputSchema,
  queryTreasuryInputSchema,
  shareEconomicIndicatorInputSchema,
  shareTopologyInputSchema,
} from '@federated-reserve/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { AxlClient, McpRouterClient } from './axl.ts';
import { mountRoutes } from './routes.ts';
import { ObserverStore, defaultManifestPath, defaultMemoryRoot } from './store.ts';
import type { ObserverEvent } from './types.ts';

function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be numeric: ${raw}`);
  return n;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

const httpPort = readNumber('OBSERVER_PORT', 3001);
const mcpPort = readNumber('MCP_SERVER_PORT', 7200);
const axl = new AxlClient(process.env.AXL_API_URL ?? 'http://127.0.0.1:9102');
const router = new McpRouterClient(process.env.MCP_ROUTER_URL ?? 'http://127.0.0.1:9103');
const memoryRoot = defaultMemoryRoot();
const store = new ObserverStore(memoryRoot, defaultManifestPath());

function makeMcpRequestHandler() {
  return async (req: Request): Promise<Response> => {
    const mcp = new McpServer(
      { name: 'federated-reserve-observer', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    mcp.registerTool(
      MCP_TOOLS.SHARE_ECONOMIC_INDICATOR,
      {
        title: 'Observe an economic indicator broadcast',
        description: 'Observer receives the same indicator fan-out as state agents.',
        inputSchema: shareEconomicIndicatorInputSchema.shape,
      },
      async (input) => {
        store.ingestIndicator(input);
        const result: ShareEconomicIndicatorResult = {
          acknowledged: true,
          receiver_fips: 0,
          received_at: new Date().toISOString(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    mcp.registerTool(
      MCP_TOOLS.ANNOUNCE_FED_RATE,
      {
        title: 'Observe a Federal Reserve rate announcement',
        description: 'Observer receives FED rate broadcasts for dashboard display.',
        inputSchema: announceFedRateInputSchema.shape,
      },
      async (input) => {
        store.ingestFedRate(input);
        const result: AnnounceFedRateResult = {
          acknowledged: true,
          receiver_fips: 0,
          received_at: new Date().toISOString(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    mcp.registerTool(
      MCP_TOOLS.QUERY_TREASURY,
      {
        title: 'Query observer treasury view',
        description: 'Read-only treasury snapshot from observer cache.',
        inputSchema: queryTreasuryInputSchema.shape,
      },
      async ({ state_fips }) => {
        const result: QueryTreasuryResult = store.queryTreasury(state_fips);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    mcp.registerTool(
      MCP_TOOLS.SHARE_TOPOLOGY,
      {
        title: 'Share observer topology',
        description: 'Returns the observer AXL node view for mesh discovery gossip.',
        inputSchema: shareTopologyInputSchema.shape,
      },
      async () => {
        const snapshot = store.snapshot();
        const result: ShareTopologyResult = {
          responder_pubkey: snapshot.mesh.observer_pubkey,
          peers: snapshot.mesh.peers,
          refreshed_at: snapshot.mesh.last_refresh_at ?? new Date(0).toISOString(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(req);
  };
}

async function refreshMesh(): Promise<void> {
  try {
    const top = await axl.peerPubkeys();
    store.updateMesh(top.self, top.peers);
  } catch (err) {
    console.warn(`[observer] topology refresh failed: ${String(err)}`);
  }
}

store.hydrateFromMemory();
store.loadInfts();
await refreshMesh();

await router.waitReady();

const mcpEndpoint = `http://127.0.0.1:${mcpPort}/mcp`;
const handleMcp = makeMcpRequestHandler();
const mcpServer = Bun.serve({
  hostname: process.env.OBSERVER_BIND ?? '0.0.0.0',
  port: mcpPort,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });
    return handleMcp(req);
  },
});

await router.register(TREASURER_SERVICE_NAME, mcpEndpoint);

const app = new Hono();
app.use('*', async (c, next) => {
  await next();
  c.header('access-control-allow-origin', '*');
  c.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  c.header('access-control-allow-headers', 'content-type');
});
app.options('*', () => json({ ok: true }));
app.get('/healthz', () =>
  json({
    ok: true,
    observer: 'phase5',
    mcp_endpoint: mcpEndpoint,
    snapshot: store.snapshot().mesh,
  }),
);
app.get('/snapshot', () => json(store.snapshot()));
app.get('/events', (c) =>
  json({ events: store.eventsSince(Number(c.req.query('limit') ?? '100')) }),
);
app.get('/infts', () => json({ entries: store.snapshot().infts }));

mountRoutes({ app, store, memoryRoot });

const clients = new Set<Bun.ServerWebSocket<unknown>>();
const unsubscribe = store.subscribe((event: ObserverEvent) => {
  const message = JSON.stringify(event);
  for (const ws of clients) ws.send(message);
});

const httpServer = Bun.serve({
  hostname: process.env.OBSERVER_BIND ?? '0.0.0.0',
  port: httpPort,
  websocket: {
    open(ws) {
      clients.add(ws);
      const payload: ObserverEvent = {
        id: 0,
        kind: 'mesh_snapshot',
        timestamp: new Date().toISOString(),
        payload: store.snapshot(),
      };
      ws.send(JSON.stringify(payload));
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {
      // Dashboard stream is server-push only for Phase 5.
    },
  },
  fetch: (req, server) => {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req);
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
});

const refreshTimer = setInterval(() => {
  store.hydrateFromMemory();
  store.loadInfts();
  void refreshMesh();
}, 5_000);

console.log(
  `[observer] ready http=http://127.0.0.1:${httpPort} ws=ws://127.0.0.1:${httpPort}/ws mcp=${mcpEndpoint}`,
);

async function shutdown(sig: string): Promise<void> {
  console.log(`[observer] ${sig} received, shutting down`);
  clearInterval(refreshTimer);
  unsubscribe();
  httpServer.stop(true);
  mcpServer.stop(true);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
