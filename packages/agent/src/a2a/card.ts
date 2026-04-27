/**
 * Per-state AgentCard generator.
 *
 * The card is served at `GET /.well-known/agent-card.json` and fetched by
 * peers via AXL's `GET /a2a/{peer_id}` discovery endpoint.
 *
 * Phase 1 only advertises `negotiate-bilateral-swap` — that's the skill we
 * implement end-to-end. The other skills declared in TECHNICAL.md
 * (participate-in-coalition, bond-auction, etc.) get added in later phases.
 */

import type { AgentCard } from '@a2a-js/sdk';
import { A2A_SKILLS } from '@federated-reserve/shared';
import type { AgentConfig } from '../config.ts';

export function buildAgentCard(cfg: AgentConfig): AgentCard {
  const stateName = cfg.state.name;
  const stateAbbr = cfg.state.abbr;
  const a2aUrl = `http://127.0.0.1:${cfg.a2a.serverPort}`;

  return {
    protocolVersion: '0.3.0',
    name: `${stateName} State Treasurer`,
    description: `Sovereign AI treasurer for ${stateName}. Manages reserves, negotiates bilateral capital flows, participates in regional coalitions, and responds to shocks.`,
    version: '0.1.0',
    url: a2aUrl,
    preferredTransport: 'JSONRPC',
    provider: {
      organization: 'Federated Reserve',
      url: 'https://federatedreserve.app',
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: A2A_SKILLS.NEGOTIATE_BILATERAL_SWAP,
        name: 'Bilateral Swap Negotiation',
        description:
          'Multi-round swap term negotiation with another state. Settles on Unichain via Uniswap.',
        tags: ['treasury', 'swap', 'bilateral', stateAbbr.toLowerCase()],
        examples: [
          `Propose: swap 1M USDC for ${stateAbbr}-TOKEN at fair value`,
          'Counter or accept proposed terms over multi-turn task',
        ],
      },
    ],
  };
}
