/**
 * Per-agent MCP server.
 *
 * Mirrors spike-01's factory pattern: stateless transport is single-use, so
 * every HTTP request gets a fresh `McpServer + WebStandardStreamableHTTPServerTransport`
 * pair.
 *
 * Tools:
 *   - `query_treasury` — returns this agent's treasury composition
 *   - `share_economic_indicator` — receives a broadcast indicator from a peer,
 *     logs it into agent state, returns ack
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  MCP_TOOLS,
  queryTreasuryInputSchema,
  shareEconomicIndicatorInputSchema,
  type QueryTreasuryResult,
  type ShareEconomicIndicatorResult,
} from '@federated-reserve/shared';
import { lookupStateByFips } from '@federated-reserve/shared';
import type { AgentConfig } from '../config.ts';
import type { AgentState } from '../state.ts';

function registerTools(mcp: McpServer, cfg: AgentConfig, state: AgentState): void {
  // ---- query_treasury ------------------------------------------------------
  mcp.registerTool(
    MCP_TOOLS.QUERY_TREASURY,
    {
      title: 'Query state treasury composition',
      description: "Get this agent's current treasury composition.",
      inputSchema: queryTreasuryInputSchema.shape,
    },
    async ({ state_fips }) => {
      const stateInfo = lookupStateByFips(state_fips) ?? cfg.state;
      // Phase 1: ignore the requested FIPS and return our own state.
      // Future phases will resolve cross-state queries via the mesh.
      const result: QueryTreasuryResult = {
        state_fips: cfg.state.fips,
        state_abbr: cfg.state.abbr,
        composition: state.composition,
        reserve_ratio: state.reserveRatio,
        total_value_usd: state.totalValueUsd,
        timestamp: new Date().toISOString(),
      };
      void stateInfo; // placeholder: keep arg parsing live
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  // ---- share_economic_indicator -------------------------------------------
  mcp.registerTool(
    MCP_TOOLS.SHARE_ECONOMIC_INDICATOR,
    {
      title: 'Share an economic indicator update',
      description:
        'Peer broadcast — receive an indicator update from another state-agent. Acknowledges receipt.',
      inputSchema: shareEconomicIndicatorInputSchema.shape,
    },
    async (input) => {
      const receivedAt = new Date().toISOString();
      state.receivedIndicators.push({ ...input, receivedAt });

      const fromAbbr = lookupStateByFips(input.state_fips)?.abbr ?? `FIPS${input.state_fips}`;
      console.log(
        `[${cfg.state.abbr}] received ${input.indicator}=${input.value} from ${fromAbbr} ` +
          `(source=${input.source}, ts=${input.timestamp})`,
      );

      const result: ShareEconomicIndicatorResult = {
        acknowledged: true,
        receiver_fips: cfg.state.fips,
        received_at: receivedAt,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );
}

/**
 * Build a per-request handler that the agent's outer Bun.serve calls into.
 * Returns a `(req: Request) => Promise<Response>` so the MCP listener can be
 * mounted at any path (we use `/mcp`).
 */
export function makeMcpRequestHandler(cfg: AgentConfig, state: AgentState) {
  return async (req: Request): Promise<Response> => {
    const mcp = new McpServer(
      { name: `${cfg.state.abbr.toLowerCase()}-treasurer`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(mcp, cfg, state);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(req);
  };
}
