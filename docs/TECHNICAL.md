# Federated Reserve — Technical Document

> Implementation plan, architecture, infrastructure, and seven-day execution plan.

---

## Stack Overview

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Bun (latest) | TypeScript runtime for all agent processes and services |
| Language | TypeScript (strict) | All application code |
| Mesh transport | AXL (Gensyn) | Peer-to-peer encrypted transport between agent nodes |
| Agent-to-agent protocol | `@a2a-js/sdk` (official, A2A v0.3.0) | Multi-turn agent coordination (negotiations, coalitions, auctions) |
| Tool protocol | `@modelcontextprotocol/sdk` (Anthropic) | Structured tool-style operations between agents |
| Smart contracts | Foundry + npm Solidity | Bond tokens, ERC-7857 iNFTs, simulated treasuries |
| Settlement | Uniswap Trading API + Unichain Sepolia | Real onchain swap execution |
| Memory / Storage | 0G Storage SDK (`@0glabs/0g-ts-sdk`) | Agent persistent memory (KV + Log) |
| Identity / Ownership | 0G Chain + ERC-7857 | iNFT contracts representing agent ownership |
| Reasoning | Anthropic Claude API | Agent decision-making (deep agents) + lightweight model for observers |
| Frontend | Next.js 15 (App Router) + shadcn/ui + Tailwind | Live ops dashboard |
| Map / Viz | deck.gl + MapLibre GL | US state map, capital flow arcs |
| Backend (frontend's) | Bun + Hono | WebSocket gateway from observer AXL node to frontend |
| Container | Docker + docker-compose locally; Fly.io machines for prod | Multi-node deployment |
| Public bootstrap node | DigitalOcean droplet or Fly.io machine | Required publicly-reachable AXL node |

### Why these choices

- **Bun + TypeScript** matches your stack and starts cold faster than Node, which matters when running 10+ agent processes locally.
- **Use the official A2A and MCP SDKs, do not build a bespoke message framework.** AXL is a *transport binding* under these protocols — see the Protocol Layering section below. Time spent reinventing JSON-RPC envelope wrappers is time not spent on the actual thesis.
- **Foundry** for contracts, but `npm` for the contract project itself (per your preference). `forge` for compilation/testing, `forge script` or `viem` for deployment.
- **Hono** because it's the fastest WebSocket server on Bun and works as a thin layer in front of the AXL HTTP bridge.
- **Next.js + shadcn + Tailwind + deck.gl** matches the worldmonitor aesthetic exactly. worldmonitor uses globe.gl + deck.gl for its dual map; we use deck.gl flat (US is flat — globe is overkill).
- **Fly.io for deployed nodes** because each AXL node needs its own machine with outbound networking, and Fly machines are cheap, fast to deploy via CLI, and trivial to colocate in different regions if we want to flex on real geographic peering.

---

## Track Integrations — What We Use, Where

### AXL (Primary track)

**What it is:** Peer-to-peer network node, single binary. Runs on each agent's machine. Exposes `localhost:9002` HTTP bridge. Handles encryption (TLS + Yggdrasil), routing, peer discovery. Built-in MCP and A2A support. Userspace, runs behind NATs without port forwarding (except for at least one bootstrap node which must be publicly reachable).

**Docs:** https://docs.gensyn.ai/tech/agent-exchange-layer
**Get started:** https://docs.gensyn.ai/tech/agent-exchange-layer/get-started
**Repo:** https://github.com/gensyn-ai/axl
**Reference impl:** https://github.com/gensyn-ai/collaborative-autoresearch-demo

**How we use it:**
- Each agent process runs an AXL node alongside it. Agent talks to its local AXL via HTTP on `localhost:9002`.
- AXL is the **transport binding** under MCP and A2A. Calling a remote agent's MCP tool is `POST localhost:9002/mcp/{peer_id}/{service}`. Calling a remote A2A skill is `POST localhost:9002/a2a/{peer_id}`. AXL wraps the JSON-RPC body in a transport envelope, routes it over Yggdrasil, and unwraps the response. The application sees a normal JSON-RPC response.
- **GossipSub** for broadcasts where every peer should hear (Fed rate announcements, shock events, economic indicator updates).
- **Convergecast** for tree-aggregated reporting (Federal agent collecting aggregate state metrics over the spanning tree).

**Qualification compliance:**
- ✅ Uses AXL for inter-agent communication (no central message broker — every MCP call and A2A skill invocation routes through AXL)
- ✅ Demonstrates communication across separate AXL nodes (deployed across real Fly.io machines, not just in-process)
- ✅ Built during hackathon

### Protocol Layering: AXL + A2A + MCP

This is the load-bearing architectural decision and worth being explicit about. From Gensyn's own framing:

> **MCP defines the tools, A2A defines the agents, and AXL makes them reachable.**

These three are layers, not alternatives. Each does one job:

| Layer | Spec | SDK | Job |
|---|---|---|---|
| Transport | AXL | (Gensyn binary) | Encrypted P2P delivery, peer discovery, NAT traversal |
| Agent coordination | A2A v0.3.0 | `@a2a-js/sdk` | Multi-turn skills, task lifecycles, negotiations |
| Tool calls | MCP | `@modelcontextprotocol/sdk` | Structured single-shot operations |

**Why this matters for the project and for judging:**
- The "Depth of AXL integration" criterion is satisfied by using AXL as the *actual transport binding* for both MCP and A2A — not as a simple message bus we layered our own protocol on top of. This is what AXL was designed for.
- For the 0G swarm criterion ("clear explanation of how agents communicate and coordinate"), the answer is clean: official A2A SDK over AXL for inter-agent coordination, MCP for tool-style operations.
- Time savings: both SDKs are mature and TypeScript-native. We write zero networking code; we focus on agent decision logic.

**How to choose between MCP and A2A for a given operation:**

Use MCP when the operation is:
- Single request → single response
- Stateless or near-stateless
- Structured input/output
- Tool-shaped (read this, execute that, return result)

Use A2A when the operation is:
- Multi-turn (back-and-forth required)
- Stateful (needs task lifecycle: Working → Completed/Failed)
- Multi-agent (coalition, auction, group decision)
- Long-running (with progress updates via SSE streaming)

A single agent exposes BOTH:
- An A2A `AgentCard` advertising skills like `negotiate-bilateral-swap`, `participate-in-coalition`, `bid-on-bond`
- An MCP server exposing tools like `share-indicator`, `query-treasury`, `execute-swap`

Other agents discover the AgentCard via AXL peer discovery, then invoke the appropriate protocol per operation.

### Uniswap Trading API

**What it is:** REST API providing quote generation and transaction calldata for swaps across 18+ chains. ~200ms routing, MEV protection, support for Permit2 and smart wallet flows. LP endpoints (just shipped) for creating/managing liquidity positions.

**Docs:** https://docs.uniswap.org/api/overview
**Trading API:** https://docs.uniswap.org/api/trading/overview
**Endpoint reference:** https://developers.uniswap.org/docs/api-reference/create_swap_transaction
**Developer Portal (get API key):** https://developers.uniswap.org/

**How we use it:**
- Each state-agent has a wallet (deterministically derived from a master seed for demo purposes — `agent-{state-fips}`).
- When an agent decides to rebalance: agent calls `/v1/quote` to get pricing, then `/v1/swap` to get calldata, signs and submits via viem on Unichain Sepolia.
- LP primitive (stretch): state-agents provide liquidity to inter-state token pools, claim fees as yield.
- **FEEDBACK.md** maintained from Day 1 — every API friction point logged with timestamp.

**Qualification compliance:**
- ✅ Real Trading API integration with onchain execution
- ✅ FEEDBACK.md present at repo root

### 0G (Storage + iNFTs)

**What it is:** Decentralized AI infrastructure — 0G Storage for persistent encrypted data, 0G Compute for verifiable inference, 0G Chain (EVM L1) for smart contracts including ERC-7857 iNFTs.

**Docs:** https://docs.0g.ai
**iNFT overview:** https://docs.0g.ai/concepts/inft
**ERC-7857 standard:** https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857
**Integration guide:** https://docs.0g.ai/developer-hub/building-on-0g/inft/integration
**SDK:** `@0glabs/0g-ts-sdk` on npm

**How we use it:**
- **0G Storage (must-ship):** Each agent persists memory to 0G Storage. KV for current state (treasury composition, latest indicators, active proposals). Log for decision history (every decision with reasoning trace, timestamp, outcome).
- **iNFTs (must-ship for 0G track):** The 8-10 deep state-agents are minted as ERC-7857 tokens on 0G Chain testnet. Encrypted metadata pointer (on 0G Storage) contains the agent's strategy weights, persona, and decision history. The token is transferable — owner controls the agent.
- **0G Compute (skip for hackathon):** Verifiable inference for reflection passes is a great future direction. Document it as future work, don't build it.

**Environment:**
```
OG_RPC_URL="https://evmrpc-testnet.0g.ai"
OG_STORAGE_URL="https://storage-testnet.0g.ai"
```

**Qualification compliance:**
- ✅ Public GitHub with README + setup
- ✅ Contract deployment addresses (will deploy ERC-7857 contract on 0G testnet)
- ✅ Demo video under 3 mins
- ✅ For iNFT projects: link to minted iNFT on 0G explorer + proof of embedded intelligence/memory (the encrypted Storage URI pointing to agent state)
- ✅ For swarms: clear explanation of agent comms (the AXL/MCP/A2A architecture serves this)

---

## System Architecture

### High-level

```
                            ┌──────────────────────────┐
                            │   Frontend (Next.js)     │
                            │   deck.gl US map +       │
                            │   live feeds + iNFT panel│
                            └────────────▲─────────────┘
                                         │ WebSocket
                                         │
                            ┌────────────┴─────────────┐
                            │   Observer Service       │
                            │   (Bun + Hono)           │
                            │   - subscribes to mesh   │
                            │   - aggregates state     │
                            │   - serves WS to UI      │
                            └────────────▲─────────────┘
                                         │ HTTP :9002
                            ┌────────────┴─────────────┐
                            │   Observer AXL Node      │
                            └────────────▲─────────────┘
                                         │
                                         │ AXL mesh (encrypted)
              ┌───────────┬──────────────┼──────────────┬───────────┐
              │           │              │              │           │
       ┌──────┴────┐┌─────┴─────┐┌──────┴─────┐┌───────┴────┐┌─────┴──────┐
       │ MA agent  ││ CA agent  ││ Fed agent  ││ Treasury   ││  ...others │
       │ + AXL     ││ + AXL     ││ + AXL      ││ + AXL      ││  + AXL     │
       │ Fly.io    ││ Fly.io    ││ Fly.io     ││ Fly.io     ││  local     │
       └────▲──────┘└─────▲─────┘└──────▲─────┘└────▲───────┘└────▲───────┘
            │             │             │           │             │
            └─────────────┴─────┬───────┴───────────┴─────────────┘
                                │
                  ┌─────────────┴─────────────┐
                  │  Shared Data Plane        │
                  │  (Bun service)            │
                  │  - FRED ingestion         │
                  │  - BLS / BEA / Census     │
                  │  - GDELT events           │
                  │  - NOAA / EIA shocks      │
                  │  - state-tagged outputs   │
                  └─────────────▲─────────────┘
                                │
                  ┌─────────────┴─────────────┐
                  │  External APIs            │
                  │  FRED, BLS, BEA, Census,  │
                  │  GDELT, NOAA, EIA, MSRB   │
                  └───────────────────────────┘

                  ┌───────────────────────────┐
                  │  Onchain settlement       │
                  │  Unichain Sepolia         │
                  │  - Uniswap pools          │
                  │  - state token contracts  │
                  │  - bond token contracts   │
                  └───────────────────────────┘

                  ┌───────────────────────────┐
                  │  0G testnet               │
                  │  - 0G Storage (memory)    │
                  │  - 0G Chain (iNFTs)       │
                  └───────────────────────────┘
```

### Per-agent process

```
┌─ Agent process (Bun) ─────────────────────────────┐
│                                                    │
│  Tick loop (1hr real = 1 quarter sim)              │
│   ↓                                                │
│  1. Fetch state snapshot from data plane           │
│  2. Read own memory from 0G Storage (KV)           │
│  3. Listen to AXL inbox (MCP server endpoint)      │
│  4. Reason via Claude API                          │
│  5. Take actions:                                  │
│     - Broadcast updates (GossipSub via AXL)        │
│     - Send proposals (MCP/A2A via AXL)             │
│     - Execute swaps (Uniswap Trading API)          │
│  6. Reflect on prior tick outcomes                 │
│  7. Persist to 0G Storage (KV update + Log append) │
│                                                    │
│  Concurrent: AXL MCP server (handles inbound       │
│  tool calls from peer agents)                      │
│                                                    │
└────────────┬───────────────────────────────────────┘
             │ HTTP localhost:9002
┌────────────┴───────────────────────────────────────┐
│  AXL node binary (single binary, no root)          │
│  - peer discovery, encryption, routing             │
└────────────────────────────────────────────────────┘
```

### Repository layout

```
federated-reserve/
├── PROJECT.md                  # vision doc
├── TECHNICAL.md                # this doc
├── README.md                   # onboarding
├── FEEDBACK.md                 # Uniswap track requirement
├── packages/
│   ├── agent/                  # main agent runtime
│   │   ├── src/
│   │   │   ├── index.ts        # entry point, AXL registration
│   │   │   ├── tick.ts         # main loop
│   │   │   ├── reason.ts       # Claude integration
│   │   │   ├── memory.ts       # 0G Storage wrapper
│   │   │   ├── axl.ts          # AXL HTTP client wrapper
│   │   │   ├── mcp/            # MCP tools (single-shot operations)
│   │   │   │   ├── server.ts
│   │   │   │   └── tools/      # query_treasury, execute_swap, ...
│   │   │   ├── a2a/            # A2A skills (multi-turn coordination)
│   │   │   │   ├── card.ts     # AgentCard generator (per-state)
│   │   │   │   ├── executor.ts # AgentExecutor implementation
│   │   │   │   └── skills/     # negotiate-bilateral-swap, bond-auction, ...
│   │   │   ├── policy/         # decision logic per state
│   │   │   ├── treasury.ts     # portfolio mgmt
│   │   │   └── execute.ts      # Uniswap execution
│   │   └── package.json
│   ├── shared/                 # shared types, schemas
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── mcp-schemas.ts  # Zod schemas for MCP tools
│   │   │   ├── a2a-types.ts    # A2A skill payload types
│   │   │   └── states.ts       # state metadata
│   │   └── package.json
│   ├── data-plane/             # ingestion service
│   │   └── src/
│   │       ├── fred.ts
│   │       ├── bls.ts
│   │       ├── gdelt.ts
│   │       ├── noaa.ts
│   │       └── server.ts
│   ├── observer/               # frontend WS gateway
│   │   └── src/
│   │       └── server.ts
│   └── frontend/               # Next.js
│       ├── app/
│       ├── components/
│       └── package.json
├── contracts/                  # Foundry project, npm-managed
│   ├── foundry.toml
│   ├── package.json
│   ├── src/
│   │   ├── StateToken.sol
│   │   ├── BondToken.sol
│   │   └── INFT7857.sol
│   ├── script/
│   └── test/
├── deploy/
│   ├── docker/
│   │   └── agent.Dockerfile
│   ├── compose/
│   │   └── local-mesh.yml      # local 10-agent dev mesh
│   └── fly/
│       └── agent.fly.toml
└── scripts/
    ├── deploy-contracts.ts
    ├── seed-pools.ts
    ├── mint-inft.ts
    └── replay-historical.ts
```

---

## Communication Layer: MCP Tools and A2A Skills

The federation's protocol, split into the right buckets.

### MCP Tools (single-shot, structured operations)

Each agent runs an MCP server registered with its local AXL node. Other agents call these via `POST localhost:9002/mcp/{peer_id}/{tool_name}`. Schemas defined with Zod, exposed via `@modelcontextprotocol/sdk`.

#### Broadcast tools (fan-out via GossipSub)

```typescript
share_economic_indicator(
  state: USStateFIPS,
  indicator: 'unemployment' | 'gdp_growth' | 'tax_revenue' | 'reserve_ratio' | ...,
  value: number,
  timestamp: ISO8601,
  source: string,  // FRED series ID, BLS table, etc.
)

announce_fed_rate(
  rate_bps: number,
  effective: ISO8601,
  rationale: string,
)

shock_event(
  event_type: 'natural_disaster' | 'market_shock' | 'policy_shock',
  affected_states: USStateFIPS[],
  severity: 1-10,
  payload: Record<string, unknown>,
)

post_credit_rating(
  rated_state: USStateFIPS,
  rating: 'AAA' | 'AA+' | ... | 'D',
  rationale: string,
)

announce_bond_auction(
  bond_id: string,
  issuer: USStateFIPS,
  principal: bigint,
  coupon_bps: number,
  maturity: ISO8601,
  auction_open_until: ISO8601,
)
```

#### Read-only query tools

```typescript
query_treasury(state: USStateFIPS) -> {
  composition: { asset: AssetId, balance: bigint }[],
  reserve_ratio: number,
  total_value_usd: number,
}

query_decision_history(
  state: USStateFIPS,
  since?: ISO8601,
) -> { decision: Decision, reasoning: string, outcome?: string }[]

query_credit_rating(state: USStateFIPS) -> {
  rating: string,
  last_updated: ISO8601,
  factors: Record<string, number>,
}
```

#### Action tools

```typescript
execute_swap(
  from_asset: AssetId,
  to_asset: AssetId,
  amount: bigint,
  max_slippage_bps: number,
) -> { tx_hash: string, received: bigint }

issue_bond(
  principal: bigint,
  coupon_bps: number,
  maturity: ISO8601,
  use_of_proceeds: string,
) -> { bond_id: string, contract_address: Address, auction_open_until: ISO8601 }
```

#### Federal-only tools

```typescript
issue_federal_transfer(
  recipient: USStateFIPS,
  amount: bigint,
  asset: AssetId,
  reason: string,
) -> { tx_hash: string }

set_federal_funds_rate(
  new_rate_bps: number,
  effective: ISO8601,
  rationale: string,
)
```

### A2A Skills (multi-turn, stateful coordination)

Each agent exposes an `AgentCard` describing its skills, served at `localhost:9002/a2a/{peer_id}/.well-known/agent.json` (resolved via AXL peer discovery). Other agents discover and invoke skills using `@a2a-js/sdk/client`. Each skill invocation creates a `Task` with a lifecycle (`Working → Completed | Failed | Canceled`) and supports SSE streaming for progress updates.

#### `negotiate-bilateral-swap`

Two-party negotiation. Initiator proposes terms; counterparty either accepts, rejects, or counters. Multi-round until convergence or timeout.

```
Task lifecycle:
  Working (proposing)
    ↓
  InputRequired (counter received, awaiting response)
    ↓
  Working (revising)
    ↓
  Completed (both sides commit; swap executes via Uniswap)
    | Failed (timeout or rejection)
```

#### `participate-in-coalition`

Multi-agent group formation. Initiator broadcasts intent, candidate members negotiate terms iteratively, group converges on shared agreement (or fails).

```
Task lifecycle: Working → InputRequired (per round) → Completed | Canceled
```

#### `bond-auction`

Issuer opens auction (broadcast via `announce_bond_auction` MCP tool first). Bidders submit bids as A2A tasks. Issuer evaluates and awards. Auction is itself an A2A task with multiple bidder sub-tasks.

```
Issuer task: Working (collecting) → Working (evaluating) → Completed (allocated)
Bidder task: Working (submitted) → Completed (won | lost)
```

#### `request-emergency-aid`

Distressed state issues an aid request. Multiple peers may respond with offers. Requester evaluates and accepts the best terms. Multi-party, time-bounded.

```
Requester: Working (broadcasting) → InputRequired (collecting offers) → Completed (accepted)
Responders: Working (offering) → Completed (accepted | declined)
```

#### `coordinate-shock-response`

Triggered by `shock_event` broadcast. States that opt in jointly negotiate a coordinated response (rate cut, transfer pool, mutual aid commitment). Convergence via iterative A2A messaging.

```
Lifecycle: Working (per agent's contribution) → Completed (joint plan committed) | Failed (no convergence)
```

### Sample AgentCard

```typescript
const massachusettsAgentCard: AgentCard = {
  name: 'Massachusetts State Treasurer',
  description: 'Manages MA treasury reserves, issues bonds, negotiates bilateral capital flows, participates in regional coalitions',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: `http://localhost:9002/a2a/${MA_PEER_ID}/jsonrpc`,
  provider: { organization: 'Federated Reserve', url: 'https://federatedreserve.app' },
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: 'negotiate-bilateral-swap',
      name: 'Bilateral Swap Negotiation',
      description: 'Multi-round swap term negotiation with another state, settlement on Unichain via Uniswap',
      tags: ['treasury', 'swap', 'bilateral'],
      examples: ['Propose to swap 1M USDC for equivalent CA-state-token at fair value'],
    },
    {
      id: 'participate-in-coalition',
      name: 'Coalition Participation',
      description: 'Join multi-state coordination on shared response to economic conditions',
      tags: ['multilateral', 'coordination'],
    },
    {
      id: 'bond-auction',
      name: 'Bond Auction',
      description: 'Issue municipal-style bonds and conduct auction; bid on peers\' bonds',
      tags: ['debt', 'auction'],
    },
    {
      id: 'request-emergency-aid',
      name: 'Emergency Aid Request',
      description: 'Request aid during fiscal stress; respond to peer aid requests',
      tags: ['shock-response', 'aid'],
    },
    {
      id: 'coordinate-shock-response',
      name: 'Shock Response Coordination',
      description: 'Negotiate joint response to natural disasters or market shocks',
      tags: ['shock-response', 'coordination'],
    },
  ],
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
};
```

### Sample wire-up (per-agent main file)

```typescript
import { AXLClient } from './axl';  // thin wrapper over localhost:9002
import {
  AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { massachusettsAgentCard } from './agent-card';
import { MassachusettsAgentExecutor } from './a2a/executor';
import { registerMcpTools } from './mcp/tools';

async function main() {
  const axl = new AXLClient({ endpoint: 'http://localhost:9002' });

  // 1. Register A2A executor
  const taskStore = new InMemoryTaskStore();
  const executor = new MassachusettsAgentExecutor(/* state, deps */);
  const a2aHandler = new DefaultRequestHandler(massachusettsAgentCard, taskStore, executor);
  await axl.registerA2A(massachusettsAgentCard, a2aHandler);

  // 2. Register MCP server
  const mcp = new McpServer({ name: 'ma-treasurer', version: '1.0.0' });
  registerMcpTools(mcp, /* state, deps */);
  await axl.registerMCP('treasurer', mcp);

  // 3. Subscribe to GossipSub topics
  await axl.subscribe(['indicators', 'fed-rate', 'shocks', 'bond-auctions'], onBroadcast);

  // 4. Start tick loop
  startTickLoop(/* state, deps */);
}
```

### Calling a peer

```typescript
// MA wants to negotiate a bilateral swap with CA
import { A2AClient } from '@a2a-js/sdk/client';

const caClient = new A2AClient(`http://localhost:9002/a2a/${CA_PEER_ID}/jsonrpc`);

const stream = caClient.sendMessageStream({
  message: {
    messageId: uuidv4(),
    role: 'user',  // MA agent acts as "user" relative to CA's executor
    parts: [{
      kind: 'application/json',
      data: {
        skill: 'negotiate-bilateral-swap',
        proposal: {
          give: { asset: 'USDC', amount: '1000000000000' },  // 1M USDC
          receive: { asset: 'CA-TOKEN', amount: '...' },
          rationale: 'Rebalancing reserve toward Pacific exposure ahead of Q3',
        },
      },
    }],
    kind: 'message',
  },
});

for await (const event of stream) {
  // Handle Working updates, InputRequired (counter-offers), Completed (with tx hash)
}
```

### Calling a peer's MCP tool

```typescript
// MA wants to query CA's treasury composition
const response = await fetch(`http://localhost:9002/mcp/${CA_PEER_ID}/treasurer`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'query_treasury',
      arguments: { state: 'CA' },
    },
  }),
});
```

The observer service runs its own AXL node that subscribes to all GossipSub topics and exposes a WebSocket to the frontend.

---

## Phase Plan

Seven days, structured as phases with concrete deliverables. **Day 0 is a half-day spike before "real" Day 1** — it gates whether AXL is viable.

### Phase 0 — Spike (Day 0, half-day, 4-6 hours)

**Purpose:** Prove the three external dependencies work before committing to them.

- [ ] Clone `gensyn-ai/axl`, build the binary, run two nodes locally
- [ ] Read `gensyn-ai/collaborative-autoresearch-demo` end to end before writing code — it's the reference impl for MCP-over-AXL
- [ ] **MCP-over-AXL spike:** wire `@modelcontextprotocol/sdk` server into AXL on node A, call its tool from node B via `localhost:9002/mcp/{peer_id}/{service}`. Verify round-trip
- [ ] **A2A-over-AXL spike:** wire `@a2a-js/sdk` `DefaultRequestHandler` into AXL on node A with a trivial AgentCard, call a skill from node B via `A2AClient` pointed at `localhost:9002/a2a/{peer_id}`. Verify task lifecycle
- [ ] Sign up for Uniswap Developer Platform key, hit `/v1/quote` from Bun script, verify response shape
- [ ] Sign up for FRED API key, hit one state-level series, verify shape
- [ ] Get 0G testnet tokens, deploy a hello-world ERC-721 (not even ERC-7857 yet) on 0G Chain testnet, verify deployed address shows on explorer
- [ ] Get Unichain Sepolia tokens, deploy a hello-world ERC-20 via Foundry, verify on explorer

**Deliverable:** A `spikes/` directory with working scripts proving each external dependency. Tag commits `spike(axl-mcp)`, `spike(axl-a2a)`, `spike(uniswap)`, `spike(fred)`, `spike(0g)`, `spike(unichain)`.

**Gate:** If AXL spike fails, escalate immediately (Gensyn Discord). Don't burn Day 1 alone on this.

### Phase 1 — Mesh Foundation (Day 1)

**Purpose:** AXL is the primary track. Get the mesh working as a real distributed system before any economic logic. **Both** MCP and A2A working through AXL by end of day — proves the protocol-layering thesis.

- [ ] Repo scaffold (monorepo, Bun workspaces, shared TS config, Biome for linting)
- [ ] `packages/shared` — types, MCP tool schemas (Zod), A2A skill type definitions, state metadata for all 50 + DC + PR
- [ ] Add deps: `@a2a-js/sdk`, `@modelcontextprotocol/sdk`, `viem`, `zod`
- [ ] `packages/agent` skeleton — main loop, AXL HTTP client wrapper
- [ ] AXL registration helpers — `axl.registerMCP(name, mcpServer)`, `axl.registerA2A(card, handler)`, `axl.subscribe(topics, handler)`
- [ ] One Dockerfile for agent runtime + AXL binary
- [ ] `deploy/compose/local-mesh.yml` running 3 agent containers + 1 bootstrap container locally
- [ ] **MCP test:** 3 agents broadcast `share_economic_indicator` via GossipSub, all 3 receive it
- [ ] **MCP test:** agent A calls `query_treasury` MCP tool on agent B, gets structured response
- [ ] **A2A test:** agent A invokes `negotiate-bilateral-swap` skill on agent B, gets back a Task with at least one InputRequired round-trip and a Completed terminal state (logic can be stubbed — what matters is the lifecycle works)

**Deliverable:** Three agents in three containers, exchanging both MCP tool calls and A2A skill invocations through real AXL transport. Commit `phase-1-mesh-foundation`.

### Phase 2 — Memory + Reasoning + AgentCards (Day 2)

**Purpose:** Agents become actually intelligent, remember things, and have real personas advertised over A2A.

- [ ] `packages/agent/src/memory.ts` — 0G Storage wrapper (KV for state, Log for history). Tested with read-after-write
- [ ] `packages/agent/src/reason.ts` — Claude API integration with prompt templates per state-agent persona
- [ ] **AgentCards for the 8 deep states** (MA, CA, TX, NY, FL, IL, WA, AK). Each has a hand-tuned persona, preserved policy stance, and full skills array. These are real artifacts judges (and the frontend) can browse
- [ ] A2A `AgentExecutor` per agent — implements all 5 skills (`negotiate-bilateral-swap`, `participate-in-coalition`, `bond-auction`, `request-emergency-aid`, `coordinate-shock-response`). Reasoning delegated to Claude
- [ ] Reflection loop — at end of each tick, agent reviews prior decision and outcome, updates "strategy notes" in 0G Storage
- [ ] `packages/data-plane` — FRED ingestion for state-level unemployment, GDP, personal income; output normalized JSON keyed by FIPS code
- [ ] Each agent reads its state's snapshot every tick

**Deliverable:** Agents make real decisions on real FRED data with persona-driven reasoning, persist to 0G Storage, and AgentCards are discoverable across the mesh. Commit `phase-2-memory-reasoning`.

### Phase 3 — Settlement (Day 3)

**Purpose:** Money actually moves. This is the Uniswap track deliverable.

- [ ] `contracts/` Foundry project. Three contracts:
  - `StateToken.sol` — per-state ERC-20 representing state's locally-issued exposure
  - `BondToken.sol` — bond instrument with coupon/maturity
  - `INFT7857.sol` — ERC-7857 iNFT (build now, mint in Phase 5)
- [ ] Deployment script. Deploy one StateToken per deep-state (8 contracts). Verify all on Unichain Sepolia explorer
- [ ] Seed Uniswap V4 pools on Unichain Sepolia: USDC paired with each StateToken (8 pools). Use the LP API
- [ ] `packages/agent/src/execute.ts` — Uniswap Trading API integration. Quote → swap → submit → confirm. Wallet per agent (deterministic from seed)
- [ ] First end-to-end: agent A proposes swap via MCP to agent B, agent B accepts, both execute their legs on Unichain. Verify both wallets show updated balances on explorer
- [ ] Bond issuance flow: agent issues a BondToken, broadcasts auction over GossipSub, peer agents bid via MCP, settlement via Uniswap

**Deliverable:** Real onchain swaps fired by AXL message exchange. FEEDBACK.md started with first batch of API friction notes. Commit `phase-3-settlement`.

### Phase 4 — Federation Scale-up (Day 4)

**Purpose:** Make it look and feel like a real federation, not a 3-node toy.

- [ ] Federal Reserve agent — sets rate quarterly, issues `announce_fed_rate` broadcasts
- [ ] Treasury agent — manages federal-to-state transfers, can issue `issue_federal_transfer`
- [ ] Algorithmic credit rating logic — meta-process scoring each state on debt-to-revenue, reserve ratio, recent performance. Affects bond auction yields
- [ ] Coalition formation flow — A2A multi-turn negotiation that converges on a coalition agreement
- [ ] Aid request → grant flow — distressed state requests aid via MCP, peers respond
- [ ] Scale local mesh to 10 deep agents + Federal + Treasury (12 containers locally)
- [ ] Add NOAA event ingestion to data plane
- [ ] Add GDELT state-tagged news ingestion
- [ ] First shock injection test: synthetic hurricane in FL, verify catastrophe response flows through mesh

**Deliverable:** 12 agents running concurrently in mesh, real federal mechanics, shock test passing. Commit `phase-4-federation-scaleup`.

### Phase 5 — Frontend + iNFTs (Day 5)

**Purpose:** Make it watchable. iNFT track deliverable.

- [ ] `packages/observer` — Bun/Hono service that runs an AXL node, subscribes to all GossipSub topics, aggregates mesh state in-memory, serves WebSocket to frontend
- [ ] `packages/frontend` — Next.js 15 app, shadcn/ui components, Tailwind
  - US map component (deck.gl + MapLibre, state polygons from Census TIGER GeoJSON)
  - Live state colorization based on treasury health
  - Capital flow arc layer (animated on swap execution events)
  - Left rail: live AXL message feed (color-coded by event type)
  - Right rail: news feed + agent-vs-actual scorecard
  - Bottom: focused state detail panel (treasury composition, decision log, swap history)
  - Top bar: sim clock, total mesh TVL, swaps/hr, mesh msg/s
  - iNFT panel: minted iNFTs with explorer links
- [ ] `scripts/mint-inft.ts` — for each deep state-agent: package its current Storage URI, encrypt metadata, mint ERC-7857 token on 0G Chain testnet, record token IDs
- [ ] iNFT contract deployed on 0G Chain, addresses recorded
- [ ] Each minted iNFT verified on 0G explorer with metadata pointer

**Deliverable:** Live dashboard URL, 8 iNFTs minted with explorer links, frontend shows the full mesh. Commit `phase-5-frontend-inft`.

### Phase 6 — Production Deploy + Polish (Day 6)

**Purpose:** Make it real. Public, deployed, sustaining.

- [ ] Public bootstrap AXL node on Fly.io (publicly reachable for mesh entry)
- [ ] Deploy 6 deep state-agents to 6 separate Fly.io machines (MA, CA, TX, NY, FL, AK) in different regions for visible geographic peering
- [ ] Federal + Treasury agents on Fly.io
- [ ] Remaining states run as containers on a single beefier Fly machine (qualifies as "separate AXL nodes" because each runs its own AXL process and has its own identity, even on shared host)
- [ ] Observer + frontend deployed to Vercel (frontend) + Fly (observer service)
- [ ] Domain set up — e.g. `federatedreserve.app` or similar
- [ ] Rate limit sanity check on FRED, BLS, Claude — back-pressure any over-eager loops
- [ ] Replay scenario: ingest historical FRED snapshot for Q1 2020, run agents on it, log full session, build the comparison-vs-actual scorecard
- [ ] Polish: animations, color schemes, microcopy
- [ ] Shock-injection demo button on frontend (admin-only) — triggers preloaded shock library
- [ ] Resilience demo: kill-a-node-and-watch-mesh-survive button

**Deliverable:** Live public URL, deployed mesh sustaining for 12+ hours, replay scenario completed end-to-end. Commit `phase-6-deploy-polish`.

### Phase 7 — Submission (Day 7)

**Purpose:** Ship the thing.

- [ ] Complete FEEDBACK.md (Uniswap requirement)
- [ ] Three READMEs: main + AXL submission notes + 0G submission notes
- [ ] Demo video (under 3 minutes — 0G hard requirement, also good practice for AXL/Uniswap)
  - 0:00–0:15 hook ("federation of state agents, real capital, no central server")
  - 0:15–0:45 architecture sketch
  - 0:45–2:15 live demo with shock injection
  - 2:15–2:45 iNFT story + comparison-to-historical
  - 2:45–3:00 pitch close
- [ ] Three submissions filed (AXL, Uniswap, 0G) with proper links
- [ ] Buffer time for the things that broke

**Deliverable:** Submitted. Commit `phase-7-submission`.

---

## Infrastructure & Deployment

### Local development

`docker-compose` brings up the full local mesh:

```yaml
# deploy/compose/local-mesh.yml (sketch)
services:
  bootstrap:
    image: federated-reserve/agent:latest
    environment:
      ROLE: bootstrap
      AXL_PUBLIC: "true"
      AXL_PORT: 9002
    ports: ["9002:9002"]
    networks: [mesh]

  agent-ma:
    image: federated-reserve/agent:latest
    environment:
      ROLE: state
      STATE_FIPS: "25"
      STATE_NAME: "Massachusetts"
      BOOTSTRAP_PEER: <pubkey-of-bootstrap>
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OG_RPC_URL: ${OG_RPC_URL}
      UNISWAP_API_KEY: ${UNISWAP_API_KEY}
      WALLET_INDEX: 25
      MASTER_SEED: ${MASTER_SEED}
    depends_on: [bootstrap, data-plane]
    networks: [mesh]

  # ...similar for CA, TX, NY, FL, IL, WA, AK
  # ...Federal and Treasury agents

  data-plane:
    image: federated-reserve/data-plane:latest
    environment:
      FRED_API_KEY: ${FRED_API_KEY}
      BLS_API_KEY: ${BLS_API_KEY}
    networks: [mesh]

  observer:
    image: federated-reserve/observer:latest
    environment:
      BOOTSTRAP_PEER: <pubkey-of-bootstrap>
    ports: ["3001:3001"]
    depends_on: [bootstrap]
    networks: [mesh]

  frontend:
    image: federated-reserve/frontend:latest
    ports: ["3000:3000"]
    depends_on: [observer]
    networks: [mesh]

networks:
  mesh:
```

### Production deployment

**Fly.io for agent nodes.** Each agent is a separate Fly machine. `fly.toml` per agent type, deployed via `flyctl deploy` per machine.

Sample agent `fly.toml`:

```toml
app = "federated-reserve-agent-ma"
primary_region = "bos"

[build]
dockerfile = "deploy/docker/agent.Dockerfile"

[env]
ROLE = "state"
STATE_FIPS = "25"
STATE_NAME = "Massachusetts"
WALLET_INDEX = "25"
BOOTSTRAP_PEER = "<set-after-bootstrap-deployed>"

[[services]]
internal_port = 9002
protocol = "tcp"
[[services.ports]]
port = 9002
handlers = ["tls"]

[[vm]]
cpu_kind = "shared"
cpus = 1
memory_mb = 1024
```

**Region placement** for visible geographic peering on demo day:

| Agent | Fly region | Rationale |
|---|---|---|
| Bootstrap | `iad` (Virginia) | Central, public, the genesis node |
| MA | `bos` (Boston) | Real geographic match |
| CA | `sjc` (San Jose) | Real geographic match |
| TX | `dfw` (Dallas) | Real geographic match |
| NY | `ewr` (Newark) | Closest to NY |
| FL | `mia` (Miami) | Real geographic match |
| AK | `sea` (Seattle) | Closest to AK |
| Fed | `iad` | Symbolic — DC-equivalent |
| Treasury | `iad` | Symbolic — DC-equivalent |

The other 40 states run as containers on a single larger Fly machine in `iad`. Each still has its own AXL identity and process — qualifies as separate AXL nodes.

**Frontend** to Vercel. **Observer service** to Fly (needs persistent connection to mesh).

### Secrets & rate limiting

All secrets via Fly secrets / Vercel env vars:

```
ANTHROPIC_API_KEY
FRED_API_KEY
BLS_API_KEY
BEA_API_KEY
UNISWAP_API_KEY
OG_RPC_URL
OG_STORAGE_URL
UNICHAIN_SEPOLIA_RPC
MASTER_SEED               # for deterministic wallet derivation
INFT_DEPLOYER_PRIVATE_KEY # for minting iNFTs
```

**Rate-limit handling per source:**

| API | Limit | Strategy |
|---|---|---|
| FRED | 120 req/min | Single ingestion service, in-memory cache, refresh per series 1x/hour |
| BLS | 500 req/day registered | Batch all series into single daily call, cache locally |
| BEA | Generous | Pull state-level GDP quarterly |
| Census | Generous | Pull annual data once at start, cache forever |
| GDELT | None published, be polite | Poll every 15 min, dedupe by article hash |
| NOAA | Generous | Poll storm events daily |
| Anthropic | Tier-based | 8 deep agents at quarterly tick = ~64 req/hour, well under limits. Observers use cheaper model or rule-based |
| Uniswap Trading API | Generous on dev tier | Quote before every swap, no batch cleverness needed |
| 0G Storage | Testnet, watch for instability | Retry with exponential backoff, fall back to local cache + replay |

**Tick interval:** 1 hour real time = 1 quarter simulated. This keeps API costs low and gives time to watch decisions unfold during demo. Can be sped up via env var for development (`TICK_INTERVAL_MS=10000` for 10-second ticks during testing).

### Wallet management

- Single `MASTER_SEED` (BIP-39 mnemonic) for the demo. Derive each agent's wallet at index = state FIPS code.
- Deterministic, reproducible across deploys.
- All wallets pre-funded from a faucet operator wallet during Phase 3 deployment.
- Production-grade: would use per-agent KMS or per-agent CDP Server Wallets, but for a 7-day testnet demo, the seed approach is appropriate and clearly documented.

### Monitoring

- Each agent logs to stdout, captured by Fly's log aggregation
- Observer service publishes mesh-health metrics (peer count, msg/s, swap success rate) to a `/health` endpoint that the frontend reads
- Simple alerting: if any agent's last-tick timestamp is > 2 hours old, frontend shows red badge on that state

---

## Key Implementation Notes

### Bun + Foundry interop

Foundry isn't a Bun project — `forge` is a Rust binary. The `contracts/` directory has its own `package.json` (npm, per your preference) for any JS interaction (e.g., a thin wrapper script). Foundry handles compilation and testing. Deploy script written in TypeScript using `viem`, run via Bun, calling out to `forge create` or directly broadcasting the bytecode.

### Why we don't use a smart-contract-based message bus

Tempting to think "well, agents are onchain anyway, why not message via events?" Because:
1. The AXL track explicitly forbids replacing what AXL provides.
2. Onchain messaging has confirmation latency that breaks the live-mesh feel.
3. Encryption is free with AXL; would have to build it onchain.

### Why we use the official A2A and MCP SDKs, not a custom framework

A2A and MCP are mature open standards with official TypeScript SDKs (`@a2a-js/sdk` from the a2aproject org, `@modelcontextprotocol/sdk` from Anthropic). They handle JSON-RPC envelopes, task lifecycles, streaming, AgentCard discovery, schema validation, and dozens of edge cases we'd otherwise reinvent.

AXL is a *transport binding* under these protocols, not a replacement for them. The Gensyn blog post explicitly frames it this way: "MCP defines the tools, A2A defines the agents, and AXL makes them reachable." Our agent code looks like normal A2A and MCP code; the only AXL-specific bit is pointing URLs at `localhost:9002/{a2a|mcp}/{peer_id}` instead of arbitrary HTTP endpoints.

This composition is also exactly what the AXL "depth of integration" judging criterion rewards: using AXL for what it was designed for (peer transport) rather than treating it as a plain message bus we built our own protocol on.

### Why one observer node and not per-agent direct connections

The frontend doesn't need its own AXL node per agent — it needs to *see* the mesh. The observer is a peer that subscribes to all GossipSub topics and serves a normalized view to the frontend. This keeps the frontend simple (WebSocket consumer) and means the AXL participation is genuinely peer-to-peer (the observer is just another peer).

### Why 8-10 deep agents and not 50

The "all 50 states" framing is what makes this *narratively* powerful. The "8-10 deep" choice is what makes it *technically* feasible. Resolution: the 8-10 are deep agents (Claude API, full reasoning, persona, full primitive support). The other 40 are observer-class — they participate in the mesh, broadcast their state's data, accept incoming proposals (with simple accept-or-reject heuristics), but don't initiate complex strategies. This is honest in the README and natural in the architecture.

### iNFT-specific implementation notes

For each deep state-agent:
1. After Phase 4, agent has accumulated decision history on 0G Storage
2. Phase 5 mint script:
   - Pulls agent's current 0G Storage URI
   - Encrypts the URI metadata bundle (strategy weights + history pointer + persona) with the deployer's key
   - Computes commitment hash
   - Calls `mint(to, encryptedURI, metadataHash)` on the deployed `INFT7857.sol`
   - Records token ID
3. iNFT panel on frontend shows: token ID, owner, link to 0G explorer, decrypted-with-owner-key preview of agent persona

To prove "intelligence is embedded": the demo includes a step where we transfer a test iNFT to a fresh wallet, the new owner re-decrypts the metadata pointer using their key, and pulls the agent's decision history from 0G Storage. That history is the embedded intelligence.

---

## Submission Checklist

### AXL
- [ ] Public GitHub repo
- [ ] README with clear setup
- [ ] Demonstration of mesh communication across separate AXL nodes (deployed Fly machines)
- [ ] Documentation of how MCP, A2A, GossipSub, and Convergecast are used (the protocol-layering story)
- [ ] Both `@modelcontextprotocol/sdk` and `@a2a-js/sdk` integrated through AXL transport
- [ ] Working examples (the live deployment + replay script)
- [ ] Demo video showing depth of AXL integration (mesh resilience: kill a node, watch routing adapt)

### Uniswap
- [ ] FEEDBACK.md at repo root with detailed builder-experience notes
- [ ] Real Trading API integration with onchain execution evidence
- [ ] Documentation of API usage patterns

### 0G
- [ ] Project name + short description
- [ ] Contract deployment addresses (INFT7857 on 0G Chain testnet)
- [ ] Public GitHub with README + setup
- [ ] Demo video under 3 minutes
- [ ] Live demo link
- [ ] List of 0G features/SDKs used (Storage SDK, ERC-7857)
- [ ] For swarms: explanation of agent comms (covered by AXL section)
- [ ] For iNFTs: links to minted iNFTs on 0G explorer + proof of embedded intelligence (decryption walkthrough)
- [ ] Team contact info (Telegram + X)

---

## What Could Go Wrong (and what we do about it)

| Risk | Likelihood | Mitigation |
|---|---|---|
| AXL has rough edges, mesh unstable | Medium | Day 0 spike. Discord. Fall back to fewer real-VM agents + more local containers if mesh is fragile in production. |
| Unichain Sepolia RPC flaky during demo | Medium | Pre-seed pools and balances before demo. Have backup recording of working demo as failsafe. |
| 0G testnet down during minting | Low-medium | Mint Phase 5, not Phase 7. Have backup of pre-minted iNFT data ready. |
| Claude rate limits hit on demo | Low | 8 deep agents at 1hr tick is well under limits. Pre-warm caches. |
| Frontend deck.gl performance at 50 states + arcs | Medium | Throttle arc animations, only render arcs for last 30s of swaps. |
| FRED/BLS API key revoked or rate-limited | Low | Cache last successful pull; fall back to last-known values rather than fake data. |
| Fly.io machine crashes mid-demo | Low | Auto-restart enabled. Mesh is designed to route around dead nodes — that's a feature, not a bug, and we demo it intentionally. |
| Out of time to finish all primitives | High | Tier 1 is must-ship, Tier 2 is should-ship, Tier 3+ are stretch. Hard cuts at end of Day 4 — anything not started by then doesn't ship. |

---

## Key Reference Links

### AXL (Gensyn)
- Docs: https://docs.gensyn.ai/tech/agent-exchange-layer
- Examples + building: https://docs.gensyn.ai/tech/agent-exchange-layer/examples-and-building
- Repo: https://github.com/gensyn-ai/axl
- Collaborative autoresearch reference impl: https://github.com/gensyn-ai/collaborative-autoresearch-demo
- "Introducing AXL" blog (transport-binding framing): https://blog.gensyn.ai/introducing-axl/

### A2A protocol
- Spec site: https://a2a-protocol.org/latest/
- A2A and MCP comparison: https://a2a-protocol.org/topics/a2a-and-mcp/
- Official JS SDK repo: https://github.com/a2aproject/a2a-js
- Official JS SDK on npm: https://www.npmjs.com/package/@a2a-js/sdk
- A2A samples: https://github.com/a2aproject/a2a-samples

### MCP protocol
- Spec: https://modelcontextprotocol.io
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk

### Uniswap
- Trading API overview: https://docs.uniswap.org/api/trading/overview
- Developer Platform (get API key): https://developers.uniswap.org/
- Endpoint reference (create swap calldata): https://developers.uniswap.org/docs/api-reference/create_swap_transaction
- Dev Platform launch blog: https://blog.uniswap.org/uniswap-developer-platform-is-live

### 0G
- Docs root: https://docs.0g.ai
- iNFT overview: https://docs.0g.ai/concepts/inft
- ERC-7857 standard: https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857
- iNFT integration guide: https://docs.0g.ai/developer-hub/building-on-0g/inft/integration
- TS SDK: `@0glabs/0g-ts-sdk` on npm

### Data sources
- FRED API: https://fred.stlouisfed.org/docs/api/fred/
- BLS API: https://www.bls.gov/developers/
- BEA API: https://apps.bea.gov/api/signup/
- Census API: https://www.census.gov/data/developers.html
- GDELT: https://www.gdeltproject.org/
- NOAA Storm Events: https://www.ncdc.noaa.gov/stormevents/
- MSRB EMMA: https://emma.msrb.org/
- OpenStates: https://openstates.org/

### UI inspiration
- worldmonitor: https://github.com/koala73/worldmonitor
- worldmonitor live: https://worldmonitor.app
