/**
 * Per-state AgentCard generator.
 *
 * Phase 2 update:
 *   - description text is hand-tuned per deep state (via personas.ts) so
 *     judges browsing AgentCards see real per-state policy posture, not a
 *     generic template
 *   - skill list now declares the four additional skills described in
 *     TECHNICAL.md (`participate-in-coalition`, `bond-auction`,
 *     `request-emergency-aid`, `coordinate-shock-response`). The executor
 *     handles `negotiate-bilateral-swap` end-to-end; the others advertise
 *     their existence so peers can discover them, and route through the
 *     same reasoner pattern as more skills land in later phases.
 */

import type { AgentCard } from '@a2a-js/sdk';
import { A2A_SKILLS, getPersona } from '@federated-reserve/shared';
import type { AgentConfig } from '../config.ts';

export function buildAgentCard(cfg: AgentConfig): AgentCard {
  const persona = getPersona(cfg.state.abbr);
  const a2aUrl = `http://127.0.0.1:${cfg.a2a.serverPort}`;
  const stateName = cfg.state.name;
  const stateAbbr = cfg.state.abbr;

  return {
    protocolVersion: '0.3.0',
    name: `${stateName} State Treasurer`,
    description: persona.tagline,
    version: '0.2.0',
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
          'Multi-round swap term negotiation with another state. Settles on Unichain via Uniswap. ' +
          'Decision logic: Claude-driven (deep tier on Opus, observers on Haiku) with deterministic fallback.',
        tags: ['treasury', 'swap', 'bilateral', stateAbbr.toLowerCase()],
        examples: [
          `Propose: swap 1M USDC for ${stateAbbr}-TOKEN at fair value`,
          'Counter or accept proposed terms over multi-turn task',
        ],
      },
      {
        id: A2A_SKILLS.PARTICIPATE_IN_COALITION,
        name: 'Coalition Participation',
        description: `Join multi-state coordination. Affinity groups: ${persona.coalitions.join(', ')}.`,
        tags: ['multilateral', 'coordination', ...persona.coalitions],
      },
      {
        id: A2A_SKILLS.BOND_AUCTION,
        name: 'Bond Auction',
        description: "Issue municipal-style bonds and conduct auctions; bid on peers' bonds.",
        tags: ['debt', 'auction'],
      },
      {
        id: A2A_SKILLS.REQUEST_EMERGENCY_AID,
        name: 'Emergency Aid',
        description: 'Request aid during fiscal stress; respond to peer aid requests.',
        tags: ['shock-response', 'aid'],
      },
      {
        id: A2A_SKILLS.COORDINATE_SHOCK_RESPONSE,
        name: 'Shock Response Coordination',
        description: 'Negotiate joint responses to natural disasters or market shocks.',
        tags: ['shock-response', 'coordination'],
      },
    ],
  };
}
