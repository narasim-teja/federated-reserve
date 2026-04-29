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

import {
  MCP_TOOLS,
  type AnnounceFedRateResult,
  type IssueFederalTransferResult,
  type QueryTreasuryResult,
  type ShareEconomicIndicatorResult,
  type ShareTopologyResult,
  announceFedRateInputSchema,
  getUsdc,
  issueFederalTransferInputSchema,
  loadDeployments,
  queryTreasuryInputSchema,
  shareEconomicIndicatorInputSchema,
  shareTopologyInputSchema,
} from '@federated-reserve/shared';
import { lookupStateByFips } from '@federated-reserve/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AxlClient } from '../axl-client.ts';
import type { AgentConfig } from '../config.ts';
import type { MeshDiscovery } from '../discovery.ts';
import type { SwapExecutor } from '../execute.ts';
import { type AgentState, pushReceivedFedRate, pushReceivedIndicator } from '../state.ts';

interface ServerDeps {
  cfg: AgentConfig;
  state: AgentState;
  axl: AxlClient;
  discovery: MeshDiscovery;
  swapExecutor?: SwapExecutor;
}

function registerTools(mcp: McpServer, deps: ServerDeps): void {
  const { cfg, state, axl, discovery } = deps;
  void axl;
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
      pushReceivedIndicator(state, { ...input, receivedAt });

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

  // ---- announce_fed_rate (Phase 4) -----------------------------------------
  // Every agent listens for this; Fed agent originates the broadcast in its
  // tick loop. The receiver records it in state.receivedFedRates so the
  // reasoner can reference policy stance in its decisions.
  mcp.registerTool(
    MCP_TOOLS.ANNOUNCE_FED_RATE,
    {
      title: 'Receive a Federal Reserve rate announcement',
      description: 'Federal Reserve broadcasts a new policy rate to the mesh.',
      inputSchema: announceFedRateInputSchema.shape,
    },
    async (input) => {
      const receivedAt = new Date().toISOString();
      pushReceivedFedRate(state, {
        rateBps: input.rate_bps,
        effective: input.effective,
        rationale: input.rationale,
        receivedAt,
      });
      console.log(
        `[${cfg.state.abbr}] received FED rate: ${input.rate_bps}bps effective ${input.effective} — ${input.rationale}`,
      );
      const result: AnnounceFedRateResult = {
        acknowledged: true,
        receiver_fips: cfg.state.fips,
        received_at: receivedAt,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ---- issue_federal_transfer (Phase 4 — Treasury action tool) ------------
  // Only the Treasury agent (FIPS 101) actually fires the on-chain transfer;
  // every other agent registers the tool but rejects with a "not authorized"
  // result. This keeps the tool universally callable for discoverability
  // while honoring the Treasury-only authority.
  mcp.registerTool(
    MCP_TOOLS.ISSUE_FEDERAL_TRANSFER,
    {
      title: 'Issue a federal-to-state transfer (Treasury only)',
      description:
        'Request Treasury to fire USDC.transfer(recipient, amount). Treasury reasoner-gates approval.',
      inputSchema: issueFederalTransferInputSchema.shape,
    },
    async (input) => {
      const recipient = lookupStateByFips(input.recipient_fips);
      if (cfg.state.abbr !== 'TRS') {
        const result: IssueFederalTransferResult = {
          approved: false,
          recipient_fips: input.recipient_fips,
          amount_usd: input.amount_usd,
          tx_hash: '',
          block_number: '',
          rationale: `${cfg.state.abbr} is not the Treasury — only TRS can issue federal transfers.`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (!recipient) {
        const result: IssueFederalTransferResult = {
          approved: false,
          recipient_fips: input.recipient_fips,
          amount_usd: input.amount_usd,
          tx_hash: '',
          block_number: '',
          rationale: `Unknown recipient FIPS ${input.recipient_fips}.`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      // Phase 4 simple gating: approve if amount < 10M and recipient is a
      // real state. Phase 5+ adds a reasoner check on recipient stress level.
      const approved = input.amount_usd > 0 && input.amount_usd < 10_000_000;
      let txHash = '';
      let blockNumber = '';
      let rationale = '';
      if (!approved) {
        rationale = `Treasury declines transfer of $${input.amount_usd} (over $10M cap or invalid amount).`;
      } else if (!deps.swapExecutor || !cfg.settlement.enabled) {
        rationale = `Treasury approval logic OK but settlement wallet not wired (settlement.enabled=${cfg.settlement.enabled}).`;
      } else {
        const recipAddr = process.env[`WALLET_${recipient.abbr}_ADDRESS`];
        if (!recipAddr) {
          rationale = `Treasury declines: no WALLET_${recipient.abbr}_ADDRESS in env.`;
        } else {
          try {
            const deployments = loadDeployments('unichain-sepolia');
            const usdc = getUsdc(deployments);
            const amountBase = BigInt(Math.floor(input.amount_usd)) * 1_000_000n;
            const r = await deps.swapExecutor.payIssuer(
              usdc.address,
              recipAddr as `0x${string}`,
              amountBase,
            );
            txHash = r.txHash;
            blockNumber = r.blockNumber.toString();
            rationale = `Treasury approves and transfers $${input.amount_usd} to ${recipient.abbr}: ${input.reason}`;
            console.log(
              `[TRS] federal transfer ${input.amount_usd} → ${recipient.abbr} tx=${r.txHash} status=${r.status}`,
            );
          } catch (err) {
            rationale = `Treasury approval logic OK but transfer threw: ${(err as Error).message}`;
          }
        }
      }
      const result: IssueFederalTransferResult = {
        approved: approved && !!txHash,
        recipient_fips: input.recipient_fips,
        amount_usd: input.amount_usd,
        tx_hash: txHash,
        block_number: blockNumber,
        rationale,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ---- share_topology ------------------------------------------------------
  mcp.registerTool(
    MCP_TOOLS.SHARE_TOPOLOGY,
    {
      title: 'Share known mesh topology',
      description:
        "Returns this agent's current view of the mesh — pubkeys it has discovered via /topology + 1-hop gossip from direct peers.",
      inputSchema: shareTopologyInputSchema.shape,
    },
    async () => {
      // Bootstrap responder pubkey lazily from /topology so we always
      // return the canonical value.
      let responderPubkey = '';
      try {
        const top = await axl.topology();
        responderPubkey = top.our_public_key;
      } catch {
        responderPubkey = '';
      }
      const result: ShareTopologyResult = {
        responder_pubkey: responderPubkey,
        peers: discovery.knownPeers(),
        refreshed_at: discovery.lastRefreshAt() ?? new Date(0).toISOString(),
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
export function makeMcpRequestHandler(deps: ServerDeps) {
  const { cfg } = deps;
  return async (req: Request): Promise<Response> => {
    const mcp = new McpServer(
      { name: `${cfg.state.abbr.toLowerCase()}-treasurer`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(mcp, deps);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(req);
  };
}
