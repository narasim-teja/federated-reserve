/**
 * Spike 01 — TypeScript MCP server using @modelcontextprotocol/sdk.
 *
 * Runs on http://127.0.0.1:7100/mcp.
 * On startup, registers itself with the Python MCP Router on http://127.0.0.1:9003.
 * On SIGINT/SIGTERM, deregisters cleanly.
 *
 * Exposes one tool — `query_treasury` — which simulates the kind of
 * single-shot, structured query a peer state-agent will make in production.
 *
 * Stateless mode caveat: WebStandardStreamableHTTPServerTransport in stateless
 * mode requires a fresh McpServer + transport per request (see MCP SDK
 * webStandardStreamableHttp.js:140). We use a factory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

const SERVICE_NAME = process.env.MCP_SERVICE_NAME ?? 'treasurer';
const SERVICE_PORT = Number(process.env.MCP_SERVICE_PORT ?? 7100);
const SERVICE_ENDPOINT = `http://127.0.0.1:${SERVICE_PORT}/mcp`;
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? 'http://127.0.0.1:9003';

// Tool registration helper — applied to every per-request McpServer instance.
function registerTools(mcp: McpServer): void {
  mcp.registerTool(
    'query_treasury',
    {
      title: 'Query state treasury composition',
      description: 'Get the current treasury composition for a US state by FIPS code.',
      inputSchema: {
        state_fips: z
          .number()
          .int()
          .min(1)
          .max(56)
          .describe('US state FIPS code, e.g. 25 for Massachusetts'),
      },
    },
    async ({ state_fips }) => {
      // Spike: hardcoded fake data. Phase 2 will read from 0G Storage.
      const fake = {
        state_fips,
        composition: [
          { asset: 'USDC', balance: '1000000000000' }, // 1M USDC (6 decimals)
          { asset: 'TBILL', balance: '500000000000' },
          { asset: 'EQUITY', balance: '250000000000' },
        ],
        reserve_ratio: 0.124,
        total_value_usd: 1_750_000,
        timestamp: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(fake, null, 2) }],
      };
    },
  );
}

// Per-request handler — fresh server + transport (stateless mode requires this).
async function handleMcpRequest(req: Request): Promise<Response> {
  const mcp = new McpServer(
    { name: 'ma-treasurer', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(mcp);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  return transport.handleRequest(req);
}

const httpServer = Bun.serve({
  port: SERVICE_PORT,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== '/mcp') {
      return new Response('not found', { status: 404 });
    }
    return handleMcpRequest(req);
  },
});

console.log(`[mcp-server] listening on ${SERVICE_ENDPOINT}`);

// ---------- Register with the Python MCP Router ----------
async function register(): Promise<void> {
  const res = await fetch(`${ROUTER_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: SERVICE_NAME, endpoint: SERVICE_ENDPOINT }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`router register failed: ${res.status} ${body}`);
  }
  console.log(`[mcp-server] registered as "${SERVICE_NAME}" with router at ${ROUTER_URL}`);
}

async function deregister(): Promise<void> {
  try {
    await fetch(`${ROUTER_URL}/register/${SERVICE_NAME}`, { method: 'DELETE' });
    console.log(`[mcp-server] deregistered "${SERVICE_NAME}"`);
  } catch (err) {
    console.error('[mcp-server] deregister failed:', err);
  }
}

let registered = false;
for (let i = 0; i < 10; i++) {
  try {
    await register();
    registered = true;
    break;
  } catch (err) {
    console.error(`[mcp-server] register attempt ${i + 1}/10 failed: ${err}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!registered) {
  console.error('[mcp-server] could not register with router; exiting');
  httpServer.stop();
  process.exit(1);
}

const shutdown = async (sig: NodeJS.Signals) => {
  console.log(`[mcp-server] received ${sig}, shutting down`);
  await deregister();
  httpServer.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
