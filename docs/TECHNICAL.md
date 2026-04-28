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
| Reasoning | OpenRouter (Claude via OpenAI-compatible API) | Agent decision-making (deep agents) + lightweight model for observers. **Never use the Anthropic SDK directly** — all LLM calls route through `OPENROUTER_API_KEY`. |
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

**What it is:** Peer-to-peer network node, single Go binary. Runs on each agent's machine. Exposes `localhost:9002` HTTP bridge. Handles encryption (TLS + Yggdrasil), routing, peer discovery. Userspace, runs behind NATs without port forwarding (except for at least one bootstrap node which must be publicly reachable).

> **Phase 0 finding — "MCP/A2A support" is *not* in-process.** AXL's `/mcp/{peer_id}/{service}` and `/a2a/{peer_id}` endpoints are bridges that forward inbound JSON-RPC to **separate local services** configured via `router_addr` (default `:9003`) and `a2a_addr` (default `:9004`). The reference implementations are Python (`vendor/axl/integrations/mcp_routing/` and `a2a_serving/`). Our TypeScript MCP servers self-register with the Python MCP Router via `POST :9003/register {service, endpoint}`. The bundled A2A server auto-derives skills from registered MCP services as request/response wrappers — **it cannot host the rich multi-turn A2A task lifecycles** described later in this doc. **Phase 1 shipped a custom TS A2A server** using `@a2a-js/sdk` that AXL forwards to via `a2a_addr` ([`packages/agent/src/a2a/server.ts`](../packages/agent/src/a2a/server.ts)).

**Docs:** https://docs.gensyn.ai/tech/agent-exchange-layer
**Get started:** https://docs.gensyn.ai/tech/agent-exchange-layer/get-started
**Repo:** https://github.com/gensyn-ai/axl
**Reference impl:** https://github.com/gensyn-ai/collaborative-autoresearch-demo

**How we use it:**
- Each agent process runs an AXL node alongside it. Agent talks to its local AXL via HTTP on `localhost:9002`.
- AXL is the **transport binding** under MCP and A2A. Calling a remote agent's MCP tool is `POST localhost:9002/mcp/{peer_id}/{service}`. Calling a remote A2A skill is `POST localhost:9002/a2a/{peer_id}`. AXL wraps the JSON-RPC body in a transport envelope, routes it over Yggdrasil, and unwraps the response. The application sees a normal JSON-RPC response.
- **Application-level fan-out** for broadcasts where every peer should hear (Fed rate announcements, shock events, economic indicator updates). **AXL does not ship a native pubsub primitive** — its HTTP surface is `/topology`, `/send`, `/recv`, `/mcp/`, `/a2a/`. Phase 1 broadcasts are implemented as O(N) MCP fan-outs over `/mcp/{peer}/treasurer` against the discovered peer set. (Earlier drafts of this doc framed this as "GossipSub"; that's aspirational vocabulary, not an AXL feature.)
- **MCP gossip discovery** — `/topology.tree` is asymmetric and lags for non-hub nodes (a leaf may not see its sibling for several minutes even though routing works). Each agent exposes a `share_topology` MCP tool returning its known pubkey set, and runs a periodic `MeshDiscovery` loop unioning own `/topology` with each direct peer's `share_topology` response. Converges in ≤10s; replaces dependence on the spanning-tree being in steady state. See [`packages/agent/src/discovery.ts`](../packages/agent/src/discovery.ts).
- **Convergecast** for tree-aggregated reporting (Federal agent collecting aggregate state metrics over the spanning tree). Built on the same fan-out + MCP `tools/call` mechanism, with the Federal agent acting as the aggregation root.

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

Validated in Phase 0 (process layout) and Phase 1 (Bun runtime + custom TS
A2A server). An "agent" is **four cooperating processes on the same host
(or container)**, wired together by AXL's `router_addr`/`a2a_addr` config.

> **This is still fully P2P.** The "no central broker" qualification refers
> to *inter-agent* communication. Each agent's MCP Router and A2A server are
> per-host sidecars in the same trust boundary as that agent's AXL node —
> Agent MA's router on Fly machine `bos` has zero awareness of Agent CA's
> router on Fly machine `sjc`. Nothing about this architecture routes one
> agent's messages through another agent's (or any third party's)
> infrastructure. The wire from MA → CA goes:
> `MA process → MA's local AXL → Yggdrasil mesh → CA's local AXL → CA's
> local router → CA's MCP server`. No central hop, no shared backend.

```
┌─ Agent process (Bun) ─────────────────────────────┐  ┌─ MCP Router ─────────┐
│                                                    │  │ (Python integrations)│
│  Tick loop (1hr real = 1 quarter sim)              │  │ port :9003           │
│   ↓                                                │  │  POST /register      │
│  1. Fetch state snapshot from data plane (Phase 2 ✅) │  POST /route         │
│  2. Read own memory (LocalDiskMemory; Phase 2 ✅,  │  └─────────▲────────────┘
│     0G Storage swap deferred to Phase 5/6)         │            │
│  3. Reason via OpenRouter preset (Phase 2 ✅)      │  ┌─────────┴────────────┐
│  4. Take actions:                                  │  │ Custom TS A2A server │
│     - Broadcast updates (app-level MCP fan-out     │  │ (Phase 1 ✅;         │
│       over discovery view, see MeshDiscovery)      │  │  uses @a2a-js/sdk)   │
│     - Send MCP calls  (POST :9002/mcp/{peer}/...)  │  │ port :9004           │
│     - Send A2A skills (POST :9002/a2a/{peer})      │  └─────────▲────────────┘
│     - Execute swaps (Uniswap Trading API) [Phase 3]│            │
│  5. Reflect on prior tick outcomes (Phase 2 ✅,    │            │
│     every REFLECT_EVERY_N_TICKS ticks)             │            │
│  6. Persist state + log via memory.saveState/      │            │
│     appendLog (Phase 2 ✅; LocalDiskMemory)        │            │
│                                                    │            │
│  Concurrent in the same Bun process:               │            │
│   - TS MCP server (Bun.serve + MCP SDK port :7100, │            │
│     registers with router on startup; tools include│            │
│     query_treasury, share_economic_indicator,      │            │
│     share_topology)                                │            │
│   - MeshDiscovery loop (10s interval; 1-hop MCP    │            │
│     gossip — unions /topology with peers'          │            │
│     share_topology to bridge spanning-tree lag)    │            │
│                                                    │            │
└────────────┬───────────────────────────────────────┘            │
             │ inbound MCP/A2A JSON-RPC                            │
             │ HTTP localhost:9002 ──── router_addr/a2a_addr ──────┘
┌────────────┴───────────────────────────────────────┐
│  AXL node binary (Go, single binary, no root)      │
│  - peer discovery (Yggdrasil), encryption, routing │
│  - bridges /mcp /a2a to local router/A2A servers   │
└────────────────────────────────────────────────────┘
```

**Startup ordering matters** (validated by Phase 0 spike-02 + Phase 1 entry
point): AXL node → MCP router → MCP server → register-with-router → A2A
server → MeshDiscovery loop → tick loop → caller. The A2A server fetches
`/topology` from AXL synchronously on startup to learn its own peer ID.
Concrete reference: [`packages/agent/src/index.ts`](../packages/agent/src/index.ts).

### Repository layout

> Phase 0 added `vendor/`, `.venv/`, `.keys/`, `spikes/`, and
> `scripts/derive-wallets.sh`. Phase 1 added `packages/{shared,agent}/`,
> `mesh/configs/`, the local-mesh runner, and the four gate-test scripts.
> Phase 2 added `packages/data-plane/`, agent-side `memory.ts` /
> `reason.ts` / `reflect.ts` / `system-prompts.ts` /
> `data-plane-client.ts`, shared `personas.ts` / `data-plane.ts`,
> mesh configs for NY+FL, and the Phase 2 gate test. Phases 3-6 add the
> rest in-place — paths annotated with their phase.

```
federated-reserve/
├── docs/
│   ├── PROJECT.md              # vision doc
│   ├── TECHNICAL.md            # this doc — Phase 2 sections marked ✅ COMPLETE 2026-04-28
│   ├── PHASE0_REPORT.md        # Phase 0 summary (2026-04-27)
│   └── PHASE1_REPORT.md        # Phase 1 summary (2026-04-27)
├── README.md                   # onboarding
├── FEEDBACK.md                 # builder-experience notes (Uniswap track requirement)
├── package.json                # root — Bun workspaces
├── tsconfig.base.json          # shared TS config
├── biome.json                  # lint + format
├── bun.lock
├── .env.example                # template for .env / .env.local
├── .gitignore
├── memory/                     # [Phase 2] per-agent persistent memory (gitignored)
│   └── {abbr}/{state.json,log.jsonl}
├── .data/                      # [Phase 2] data-plane disk cache (gitignored)
│   └── data-plane-cache.json
├── vendor/
│   └── axl/                    # cloned + built from gensyn-ai/axl (Phase 0)
│       └── node                # the compiled Go binary
├── .venv/                      # Python venv with mcp_routing + a2a_serving
├── .keys/                      # ed25519 PEMs for AXL nodes (gitignored)
├── spikes/                     # Phase 0 dependency spikes (00 through 06)
├── mesh/
│   └── configs/                # AXL node configs for the local mesh
│       └── node-{ma,ca,tx,ny,fl}.json   # MA/CA/TX = Phase 1; NY/FL = Phase 2
├── scripts/
│   ├── derive-wallets.sh       # [Phase 0] re-derives agent hierarchy from MASTER_SEED
│   ├── run-local-mesh.sh       # [Phase 1+2] boots 5 AXL + 5 routers + 5 agents + data plane
│   ├── test-mcp-unicast.sh     # [Phase 1 gate test] CA → MA query_treasury
│   ├── test-mcp-discovery.sh   # [Phase 1 gate test] gossip convergence
│   ├── test-mcp-broadcast.sh   # [Phase 1 gate test] CA → {MA,TX} fan-out
│   ├── test-a2a-negotiate.sh   # [Phase 1 gate test] multi-turn lifecycle (deterministic stub era)
│   ├── test-phase2-gate.sh     # [Phase 2 gate test] full Phase 2 deliverable verification
│   ├── deploy-contracts.ts     # [Phase 3]
│   ├── seed-pools.ts           # [Phase 3]
│   ├── mint-inft.ts            # [Phase 5]
│   └── replay-historical.ts    # [Phase 6]
├── packages/
│   ├── shared/                 # [Phase 1+2] shared types, Zod schemas
│   │   ├── src/
│   │   │   ├── states.ts       # 50 + DC + PR metadata (FIPS, abbr, region, tier)
│   │   │   ├── mcp-schemas.ts  # Zod schemas: query_treasury, share_economic_indicator,
│   │   │   │                   # share_topology
│   │   │   ├── a2a-types.ts    # A2A skill schemas — negotiate-bilateral-swap (Phase 1) +
│   │   │   │                   # skillEnvelopeSchema for the 4 Phase 2 skills
│   │   │   ├── data-plane.ts   # [Phase 2] StateSnapshot / IndicatorObservation / health
│   │   │   ├── personas.ts     # [Phase 2] hand-tuned posture + coalitions per deep state
│   │   │   └── index.ts
│   │   └── package.json
│   ├── agent/                  # [Phase 1+2] per-agent runtime — single Bun process
│   │   ├── src/
│   │   │   ├── index.ts            # entry point — startup/shutdown ordering (memory + reasoner wired in Phase 2)
│   │   │   ├── config.ts           # env → AgentConfig (Phase 2 adds dataPlaneUrl, REFLECT_EVERY_N_TICKS, reasoningEnabled)
│   │   │   ├── state.ts            # in-memory working copy (loaded from / saved to AgentMemory)
│   │   │   ├── memory.ts           # [Phase 2] AgentMemory interface + LocalDiskMemory (0G impl deferred)
│   │   │   ├── reason.ts           # [Phase 2] OpenRouter chat-completions client (preset-driven)
│   │   │   ├── reflect.ts          # [Phase 2] reflection loop (every Nth tick)
│   │   │   ├── system-prompts.ts   # [Phase 2] per-agent system prompt baked from (state, persona)
│   │   │   ├── data-plane-client.ts# [Phase 2] thin HTTP client to the data plane
│   │   │   ├── axl-client.ts       # /topology /send /recv /mcp /a2a wrapper
│   │   │   ├── mcp-router-client.ts# Python MCP Router register/deregister
│   │   │   ├── discovery.ts        # 1-hop MCP gossip (share_topology refresh loop)
│   │   │   ├── broadcast.ts        # app-level fan-out helper (uses discovery)
│   │   │   ├── tick.ts             # data-plane snapshot → broadcast → memory.saveState → reflect
│   │   │   ├── mcp/
│   │   │   │   └── server.ts       # factory-pattern MCP server (Bun.serve)
│   │   │   └── a2a/
│   │   │       ├── card.ts         # persona-driven AgentCard generator (Phase 2)
│   │   │       ├── server.ts       # @a2a-js/sdk JsonRpcTransportHandler on Bun.serve
│   │   │       └── executor.ts     # AgentExecutor — Phase 1 negotiate + Phase 2 four new skills, all reasoner-driven
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── data-plane/             # [Phase 2] FRED ingestion sidecar (HTTP service)
│   │   ├── src/
│   │   │   ├── index.ts        # Bun.serve — /healthz, /snapshot/:fips, /snapshots, POST /refresh
│   │   │   ├── cache.ts        # in-memory map + JSON disk persistence
│   │   │   ├── rate-limit.ts   # serial-chain min-interval limiter (token-bucket replacement)
│   │   │   ├── scheduler.ts    # periodic refresh + failure tracking for /healthz
│   │   │   └── sources/
│   │   │       └── fred.ts     # FRED fetcher with 429/5xx retry-with-backoff
│   │   └── package.json
│   ├── observer/               # [Phase 5] frontend WS gateway
│   │   └── src/server.ts
│   └── frontend/               # [Phase 5] Next.js
│       ├── app/, components/
│       └── package.json
├── contracts/                  # [Phase 3] Foundry, npm-managed
│   ├── foundry.toml
│   ├── package.json
│   ├── src/{StateToken,BondToken,INFT7857}.sol
│   ├── script/
│   └── test/
└── deploy/                     # [Phase 6]
    ├── docker/agent.Dockerfile
    ├── compose/local-mesh.yml
    └── fly/agent.fly.toml
```

---

## Communication Layer: MCP Tools and A2A Skills

The federation's protocol, split into the right buckets.

### MCP Tools (single-shot, structured operations)

Each agent runs an MCP server registered with its local AXL node. Other agents call these via `POST localhost:9002/mcp/{peer_id}/{tool_name}`. Schemas defined with Zod, exposed via `@modelcontextprotocol/sdk`.

#### Broadcast tools (fan-out at the application layer)

> AXL has no native pubsub. "Broadcast" tools are MCP tools that the
> initiator calls on every peer in turn (Phase 1 implementation in
> [`packages/agent/src/broadcast.ts`](../packages/agent/src/broadcast.ts)).

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

// [Phase 1 ✅] mesh discovery — used by MeshDiscovery to bridge the
// /topology.tree convergence lag. Caller takes the union over all peers.
share_topology() -> {
  responder_pubkey: string,
  peers: string[],     // hex pubkeys, excluding self
  refreshed_at: ISO8601,
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

> **Phase 0 update.** The earlier draft of this section showed pseudocode
> like `axl.registerMCP(...)` / `axl.registerA2A(...)`. Those APIs do not
> exist — AXL has no in-process registration. Real wiring is two HTTP
> services that AXL forwards inbound `/mcp` and `/a2a` requests to. The
> snippet below reflects what Phase 0 spikes 01 and 02 actually validated
> (see [`spikes/01-axl-mcp/server.ts`](../spikes/01-axl-mcp/server.ts)).

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import { massachusettsAgentCard } from './agent-card';
import { MassachusettsAgentExecutor } from './a2a/executor';
import { registerMcpTools } from './mcp/tools';

async function main() {
  // 1. MCP SERVER — Bun HTTP on :7100 ────────────────────────────────────
  // The MCP SDK's stateless transport is single-use, so instantiate a
  // fresh McpServer + transport per HTTP request (Phase 0 finding).
  Bun.serve({
    port: 7100,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });
      const mcp = new McpServer(
        { name: 'ma-treasurer', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      registerMcpTools(mcp, /* state, deps */);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // stateless
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });

  // Register with the (Python) MCP Router so AXL knows where to forward
  // inbound `POST :9002/mcp/{peer_id}/treasurer` to.
  await fetch('http://127.0.0.1:9003/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: 'treasurer',
      endpoint: 'http://127.0.0.1:7100/mcp',
    }),
  });

  // 2. A2A SERVER — custom TS service on :9004 ───────────────────────────
  // This REPLACES the bundled Python `a2a_serving.a2a_server` because we
  // need rich task lifecycles (Working → InputRequired → Completed) for
  // negotiate-bilateral-swap etc. AXL is configured (in node-config.json)
  // to forward inbound `POST :9002/a2a/{peer_id}` to a2a_addr=:9004.
  const taskStore = new InMemoryTaskStore();
  const executor = new MassachusettsAgentExecutor(/* state, deps */);
  const a2aHandler = new DefaultRequestHandler(
    massachusettsAgentCard, taskStore, executor,
  );
  // (Wire `a2aHandler` up to a Bun.serve on :9004; the @a2a-js/sdk server
  //  side accepts a Web-standard Request handler.)

  // 3. App-level broadcast fan-out helper (no GossipSub primitive in AXL)
  //    — see packages/agent/src/broadcast.ts. The tick loop calls this
  //    each iteration to fan out share_economic_indicator etc.
  startTickLoop(/* state, deps, axl, broadcast */);

  // 4. Start tick loop
  startTickLoop(/* state, deps */);
}
```

**AXL itself runs as a sidecar** (e.g. via `vendor/axl/node -config node-X.json`
in a separate process or container). Its `node-config.json` for an agent host
must include:

```json
{
  "router_addr": "http://127.0.0.1", "router_port": 9003,
  "a2a_addr":    "http://127.0.0.1", "a2a_port":    9004
}
```

### Calling a peer

> **Phase 1 ✅.** The snippet below uses the **custom TS A2A server**
> shipped in Phase 1 (not the bundled Python `a2a_serving`). The
> multi-turn `Working → InputRequired → Completed` lifecycle is live in
> [`packages/agent/src/a2a/executor.ts`](../packages/agent/src/a2a/executor.ts)
> with deterministic stub logic; Phase 2 swaps the stub for Claude.

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

The observer service runs its own AXL node and exposes both the same MCP `share_economic_indicator` tool the agents use (so other agents fan out indicators to it for free) and a WebSocket to the frontend that re-emits each received message.

---

## Phase Plan

Seven days, structured as phases with concrete deliverables. **Day 0 is a half-day spike before "real" Day 1** — it gates whether AXL is viable.

### Phase 0 — Spike (Day 0, half-day, 4-6 hours) — ✅ COMPLETE 2026-04-27

**Purpose:** Prove the external dependencies work before committing to them.
**Outcome:** Three AXL spikes green; four data/chain spikes scaffolded and
SKIP cleanly until creds + funded wallets land. Full report in
[docs/PHASE0_REPORT.md](./PHASE0_REPORT.md).

- [x] Clone `gensyn-ai/axl`, build the binary, run two nodes locally — built into [`vendor/axl/node`](../vendor/axl/)
- [x] **AXL transport spike** — [`spikes/00-axl-nodes`](../spikes/00-axl-nodes); `/topology` + `/send` + `/recv` round-trip ✅
- [x] **MCP-over-AXL spike** — [`spikes/01-axl-mcp`](../spikes/01-axl-mcp); TS `@modelcontextprotocol/sdk` server registers with Python MCP Router, peer calls `tools/list` and `tools/call` ✅
- [x] **A2A-over-AXL spike** — [`spikes/02-axl-a2a`](../spikes/02-axl-a2a); bundled Python A2A server returns agent card and round-trips `SendMessage` ✅ (limitation noted: bundled server is MCP-derived; a custom TS A2A server is a Phase 1 task)
- [x] Uniswap `/v1/quote` Bun script — [`spikes/03-uniswap-quote`](../spikes/03-uniswap-quote) ⏸ SKIP until `UNISWAP_API_KEY` populated
- [x] FRED state-level series Bun script — [`spikes/04-fred-series`](../spikes/04-fred-series) ⏸ SKIP until `FRED_API_KEY` populated
- [x] 0G hello-world ERC-721 Foundry deploy — [`spikes/05-0g-erc721`](../spikes/05-0g-erc721) ⏸ SKIP until deployer funded on 0G testnet
- [x] Unichain Sepolia hello-world ERC-20 Foundry deploy — [`spikes/06-unichain-erc20`](../spikes/06-unichain-erc20) ⏸ SKIP until deployer funded on Unichain Sepolia

**Findings folded back into this doc** (see Phase 0 callouts throughout):
the Python integrations are mandatory, the bundled A2A server is too thin
for our Phase 1+ skills, MCP SDK stateless transport is single-use, and
several pinned-version workarounds — all captured under the new
[Pinned versions and Phase 0 gotchas](#pinned-versions-and-phase-0-gotchas)
section below. [FEEDBACK.md](../FEEDBACK.md) has the full builder-experience log.

**Gate result:** AXL works → cleared to start Phase 1.

### Phase 1 — Mesh Foundation (Day 1) — ✅ COMPLETE 2026-04-27

**Purpose:** AXL is the primary track. Get the mesh working as a real distributed system before any economic logic. **Both** MCP and A2A working through AXL by end of day — proves the protocol-layering thesis.

**Outcome:** 3-agent local mesh (MA/CA/TX) running end-to-end. All three
gate tests green. Full report in [docs/PHASE1_REPORT.md](./PHASE1_REPORT.md).

- [x] Repo scaffold ([package.json](../package.json) + Bun workspaces, [tsconfig.base.json](../tsconfig.base.json), [biome.json](../biome.json))
- [x] `packages/shared` — types, MCP tool Zod schemas, A2A skill types, state metadata for 50+DC+PR (all entries with FIPS/abbr/name/region/tier)
- [x] Deps wired: `@a2a-js/sdk`, `@modelcontextprotocol/sdk`, `zod` (viem deferred to Phase 3 — no chain code yet; OpenRouter client deferred to Phase 2 alongside reasoning)
- [x] `packages/agent` skeleton — entry point with startup/shutdown ordering, MCP-router-client (`POST :9003/register` + deregister), per-request `McpServer` factory
- [x] **Custom TS A2A server** using `@a2a-js/sdk` `DefaultRequestHandler` + `JsonRpcTransportHandler` over `Bun.serve`, replacing the bundled Python `a2a_serving.a2a_server`. Hosts the multi-turn `negotiate-bilateral-swap` lifecycle (deterministic stub for Phase 1; OpenRouter wires in at Phase 2).
- [ ] Dockerfile per agent + `deploy/compose/local-mesh.yml` — **deferred to Phase 6 packaging.** Phase 1 confirmed the topology with bare Bun processes via [`scripts/run-local-mesh.sh`](../scripts/run-local-mesh.sh); containerization is a packaging concern, not a correctness concern.
- [x] **MCP test:** app-level `share_economic_indicator` fan-out — receivers log the indicator. AXL has **no native pubsub**; broadcasts are O(N) MCP fan-outs over `/mcp/{peer}/treasurer`. ([`scripts/test-mcp-broadcast.sh`](../scripts/test-mcp-broadcast.sh))
- [x] **MCP test:** agent A calls `query_treasury` MCP tool on agent B over AXL. ([`scripts/test-mcp-unicast.sh`](../scripts/test-mcp-unicast.sh))
- [x] **A2A test:** `negotiate-bilateral-swap` lifecycle `Working → InputRequired → Working → Completed` over the custom TS A2A server. ([`scripts/test-a2a-negotiate.sh`](../scripts/test-a2a-negotiate.sh))

**Deliverable:** ✅ 3 agents on bare Bun processes (containerization is Phase 6) exchanging both MCP tool calls and A2A skill invocations through real AXL transport.

### Phase 2 — Memory + Reasoning + AgentCards (Day 2) — ✅ COMPLETE 2026-04-28

**Purpose:** Agents become actually intelligent, remember things, and have real personas advertised over A2A. **Builds on the Phase 1 mesh** ([`packages/agent/`](../packages/agent/) is already running — Phase 2 fills in the stubbed `state.ts` (in-memory) with persistent memory, the deterministic A2A `executor.ts` with reasoner-driven logic, and adds new modules for ingestion).

**Outcome:** 5-agent mesh (MA/CA/TX/NY/FL) running end-to-end with real FRED
data, reasoner-driven negotiation, persona-driven AgentCards, and per-agent
disk memory. The Phase 2 gate test
([`scripts/test-phase2-gate.sh`](../scripts/test-phase2-gate.sh)) is **13/13
green, 0 warnings, 0 failures** when FRED + OpenRouter keys are populated.

> **Pulled forward from this phase into Phase 1:**
> - `share_topology` MCP tool + `MeshDiscovery` gossip loop (was a "Phase 2 task" in the original plan; shipped in Phase 1 because the broadcast helper depended on it).

> **Deferred from this phase to later:**
> - **0G Storage persistence** — Phase 2 ships [`LocalDiskMemory`](../packages/agent/src/memory.ts) (per-agent JSON state + JSONL log under `<repo>/memory/<abbr>/`). The `AgentMemory` interface is the swap point; `OgStorageMemory` will land alongside iNFT minting in Phase 5/6 once the 0G testnet wallet is funded. `MEMORY_BACKEND=local` is the default; `MEMORY_BACKEND=og` will activate the alternate impl when ready.

#### Memory & reasoning

- [x] **`packages/agent/src/memory.ts`** — `AgentMemory` interface with `LocalDiskMemory` (JSON state.json + JSONL log.jsonl per agent under `MEMORY_ROOT`) and `InMemoryMemory` test variant. State hydrates on startup; tick loop persists after every tick; the JSONL log captures broadcasts, reflections, and (soon) negotiation outcomes. **0G Storage backend deferred to Phase 5/6** behind the same interface.
- [x] **`packages/agent/src/reason.ts`** — OpenRouter chat-completions client. Resolves `OPENROUTER_PRESET_DEEP` / `OPENROUTER_PRESET_OBSERVER` (bare slug or `@preset/<slug>`) to `model: "@preset/<slug>"`. **System prompt lives in code** ([`packages/agent/src/system-prompts.ts`](../packages/agent/src/system-prompts.ts)) so it tracks in git; preset only sets *model + sampling*. 429/5xx retry-with-backoff. JSON-mode helper for structured decisions. *Phase 2 hackathon run uses Gemini 3 Flash on both presets as a cost-down; the code is preset-agnostic and Opus/Haiku is a one-line OpenRouter UI swap.*
- [x] **Reasoner-driven `negotiate-bilateral-swap`** in [`a2a/executor.ts`](../packages/agent/src/a2a/executor.ts) — accept / counter / reject decided by JSON-mode call against persona + treasury + indicator context. Deterministic 5%-haircut counter as fallback when OpenRouter is unreachable or `REASONING_ENABLED=0`.
- [x] **All four additional A2A skills implemented** in the same executor: `participate-in-coalition`, `bond-auction`, `request-emergency-aid`, `coordinate-shock-response`. Schemas in [`packages/shared/src/a2a-types.ts`](../packages/shared/src/a2a-types.ts) (`skillEnvelopeSchema` discriminated union); each handler runs a single reasoning pass and emits `Working → Completed` with the structured response. Phase 1's negotiate lifecycle stays multi-turn (`Working → InputRequired → Completed`); Phase 3+ extends the others to multi-turn as their economic primitives need it.
- [x] **Reflection loop** — [`packages/agent/src/reflect.ts`](../packages/agent/src/reflect.ts) runs every `REFLECT_EVERY_N_TICKS` ticks (default 4). Reads recent log entries, asks the reasoner for a 2-3 sentence summary referencing the system-prompt-baked posture, persists as `kind: "reflection"` log entry. Sample MA reflection from the Phase 2 run: *"The persistence of the 4.8% unemployment rate confirms a cooling trend in the Commonwealth's labor market, though our reserve ratio remains a healthy 12.4% with a dominant $1.5 trillion position in liquid cash and T-bills... I must now watch for any further softening in personal income data that could signal a deeper structural downturn, requiring me to coordinate with my Northeast coalition partners on a joint stabilization strategy."*

#### Personas

- [x] **Per-state policy posture** for the 8 deep states (MA, CA, TX, NY, FL, IL, WA, AK) hand-tuned in [`packages/shared/src/personas.ts`](../packages/shared/src/personas.ts) — taglines for AgentCard descriptions, multi-sentence posture text injected into the system prompt, coalition-affinity tags for the coalition skill. Observer states get a region-fallback persona so all 50 states have honest taglines.
- [x] **Per-agent system prompt baked at startup** ([`packages/agent/src/system-prompts.ts`](../packages/agent/src/system-prompts.ts)) — composition of `(state, persona)` covering identity, posture, coalition affinity, decision principles (reserve-ratio-first), and JSON-vs-prose response format conventions. Threaded through every `reasoner.reason*()` call as the OpenAI-style `system` message. Trimmed redundant role/posture lines from per-skill user messages now that the system prompt covers them.

#### Real public data

- [x] **`packages/data-plane/`** — Bun/HTTP service with FRED ingestion. `GET /healthz`, `GET /snapshot/:fips`, `GET /snapshots`, `POST /refresh`. Fetches per-state `{ABBR}UR` (monthly unemployment) and `{ABBR}PCPI` (annual per-capita personal income). Disk-backed cache at `.data/data-plane-cache.json` survives restart. Refresh interval 1h (FRED state series tick monthly).
- [x] **Rate-limited correctly** — Phase 2 surfaced a real bug in the original token-bucket: concurrent waiters each refilled and resolved without checking tokens, leaking ~5 req/sec at a configured 1.33. Replaced with a serial promise-chain limiter that enforces a strict minimum interval between releases ([`packages/data-plane/src/rate-limit.ts`](../packages/data-plane/src/rate-limit.ts)). Configured at 1 req/sec (60/min budget vs FRED's documented 120/min). FRED 429/5xx retry-with-backoff per fetch. **Result: 0 upstream failures across all 104 requests** (was 84 before the fix).
- [x] **Each agent reads its state's snapshot every tick** ([`tick.ts`](../packages/agent/src/tick.ts) → [`data-plane-client.ts`](../packages/agent/src/data-plane-client.ts)). Tick skips broadcast if no snapshot is available yet — never fakes data per the project non-goals.
- [x] **Indicator broadcasts use real FRED data** — `pickBroadcastIndicator` selects the freshest available, source string is the FRED series ID (e.g. `FRED:MAUR`). Phase 2 verified MA broadcasting `unemployment=4.8 (FRED:MAUR, observed 2026-02-01)` to its 4 peers.

#### Per-state AgentCards

- [x] **AgentCards now persona-driven** ([`packages/agent/src/a2a/card.ts`](../packages/agent/src/a2a/card.ts)) — `description` field uses the persona's `tagline` per state (e.g. MA: *"Tech-revenue-correlated treasurer with strong reserves; biased toward active coalition leadership in the Northeast."*), 5 skills advertised. Browsable via `GET http://localhost:9002/a2a/{peer_id}` over AXL — judges can list a peer's capabilities cold.

#### Phase 2 gate — ✅ 13/13 PASS

[`scripts/test-phase2-gate.sh`](../scripts/test-phase2-gate.sh):

```
✓ data plane has 52 states loaded
✓ MA snapshot has 2 populated indicator(s)
✓ memory/{ma,ca,tx,ny,fl}/state.json present (tickCount>0)
✓ MA broadcast log contains FRED-sourced indicator
✓ at least one agent has a reflection log entry
✓ MA AgentCard has persona-driven tagline (5 skills advertised)
✓ negotiate round 1: state=input-required
✓ negotiate round 2: state=completed with settlement payload
✓ participate-in-coalition completed (responder kind=joined)
```

**Bugs surfaced + fixed during the Phase 2 run:**
1. Token bucket rate limiter race (described above).
2. `LocalDiskMemory` resolved memory under `process.cwd()` which is the package dir (because the mesh runner `cd`s into `packages/agent/` before `bun run`). Added `MEMORY_ROOT` env var honored by memory.ts and exported by [`scripts/run-local-mesh.sh`](../scripts/run-local-mesh.sh) → `<repo-root>/memory`.
3. AgentCard probe path — AXL forwards `/a2a/{peer}` to `/.well-known/agent-card.json` server-side; the probe was double-appending it.

**Deliverable:** 5-agent mesh on bare Bun processes with real FRED data, reasoner-driven negotiation + 4 additional A2A skills, persona-driven AgentCards, per-agent disk memory, and a working reflection loop. Commit `phase-2-memory-reasoning`.

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
- [ ] Bond issuance flow: agent issues a BondToken, fans out an `announce_bond_auction` MCP broadcast, peer agents bid via MCP, settlement via Uniswap

**Deliverable:** Real onchain swaps fired by AXL message exchange. FEEDBACK.md started with first batch of API friction notes. Commit `phase-3-settlement`.

### Phase 4 — Federation Scale-up (Day 4)

**Purpose:** Make it look and feel like a real federation, not a 3-node toy.

- [ ] Federal Reserve agent — sets rate quarterly, issues `announce_fed_rate` broadcasts
- [ ] Treasury agent — manages federal-to-state transfers, can issue `issue_federal_transfer`
- [ ] Algorithmic credit rating logic — meta-process scoring each state on debt-to-revenue, reserve ratio, recent performance. Affects bond auction yields
- [ ] Coalition formation flow — A2A multi-turn negotiation that converges on a coalition agreement
- [ ] Aid request → grant flow — distressed state requests aid via MCP, peers respond
- [ ] Scale local mesh to 10 deep agents + Federal + Treasury (12 Bun processes locally; containerization still deferred to Phase 6) — extend [`scripts/run-local-mesh.sh`](../scripts/run-local-mesh.sh) and [`mesh/configs/`](../mesh/configs/)
- [ ] Add NOAA event ingestion to data plane
- [ ] Add GDELT state-tagged news ingestion
- [ ] First shock injection test: synthetic hurricane in FL, verify catastrophe response flows through mesh

**Deliverable:** 12 agents running concurrently in mesh, real federal mechanics, shock test passing. Commit `phase-4-federation-scaleup`.

### Phase 5 — Frontend + iNFTs (Day 5)

**Purpose:** Make it watchable. iNFT track deliverable.

- [ ] `packages/observer` — Bun/Hono service that runs an AXL node and an MCP server exposing `share_economic_indicator` (so agents fan out indicators to it like any other peer), aggregates mesh state in-memory, serves WebSocket to frontend
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

- [ ] Containerize: `deploy/docker/agent.Dockerfile` (AXL binary + Python venv for MCP router + Bun runtime + TS code) and `deploy/compose/local-mesh.yml`. **Deferred from Phase 1** — needed now for Fly.io deploy.
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

`docker-compose` brings up the full local mesh.

> **Phase 0 reality:** each agent container actually runs **four processes** —
> AXL node + Python MCP Router + TS MCP server + TS A2A server (see the
> per-agent diagram earlier). The compose sketch below collapses them into a
> single `image: federated-reserve/agent:latest` started by an entrypoint
> script. See [docs/PHASE0_REPORT.md](./PHASE0_REPORT.md) for the validated
> startup ordering.

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
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}    # NOT ANTHROPIC_API_KEY
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
OPENROUTER_API_KEY        # all LLM calls — never use ANTHROPIC_API_KEY directly
FRED_API_KEY
BLS_API_KEY
BEA_API_KEY
UNISWAP_API_KEY
OG_RPC_URL
OG_STORAGE_URL
UNICHAIN_SEPOLIA_RPC
MASTER_SEED               # BIP-39, for deterministic wallet derivation (Phase 1+ derives at runtime)
INFT_DEPLOYER_PRIVATE_KEY # for minting iNFTs (Phase 5)
```

**Rate-limit handling per source:**

| API | Limit | Strategy |
|---|---|---|
| FRED | 120 req/min documented; **observed 429s well below that** | Phase 2 ✅ — single ingestion service ([`packages/data-plane`](../packages/data-plane/)), in-memory + disk cache, refresh per series 1x/hour. Rate-limited at **1 req/sec** (60/min) via a serial-chain min-interval limiter (an earlier token-bucket draft had a concurrent-waiter race that leaked ~5 req/sec). 429/5xx retry-with-backoff per fetch. Result: 0 upstream failures across 104 reqs/refresh. |
| BLS | 500 req/day registered | Batch all series into single daily call, cache locally (Phase 4) |
| BEA | Generous | Pull state-level GDP quarterly (Phase 4) |
| Census | Generous | Pull annual data once at start, cache forever (Phase 4) |
| GDELT | None published, be polite | Poll every 15 min, dedupe by article hash (Phase 4) |
| NOAA | Generous | Poll storm events daily (Phase 4) |
| OpenRouter | Per-preset + account credits | Phase 2 ✅ — **all 50 agents are LLM-driven** via OpenRouter *presets*: agent code references `@preset/<slug>` (env: `OPENROUTER_PRESET_DEEP` / `OPENROUTER_PRESET_OBSERVER`); the preset binds *model + sampling params* in the OpenRouter UI, while **the system prompt lives in code** ([`packages/agent/src/system-prompts.ts`](../packages/agent/src/system-prompts.ts)) so it tracks in git. Default tier mapping: deep → Claude Opus 4.7, observer → Claude Haiku 4.5; the Phase 2 hackathon run uses Gemini 3 Flash on both presets as a cost-down. Per-call retry-with-backoff on 429/5xx in [`reason.ts`](../packages/agent/src/reason.ts). |
| Uniswap Trading API | Generous on dev tier | Quote before every swap, no batch cleverness needed |
| 0G Storage | Testnet, watch for instability | Retry with exponential backoff, fall back to local cache + replay |

**Tick interval:** 1 hour real time = 1 quarter simulated. This keeps API costs low and gives time to watch decisions unfold during demo. Can be sped up via env var for development (`TICK_INTERVAL_MS=10000` for 10-second ticks during testing).

### Wallet management

- Single `MASTER_SEED` (BIP-39 mnemonic) for the demo. Derive each agent's wallet at index = state FIPS code.
- Index assignments (Phase 0 chose these to avoid FIPS collisions): `0` = master deployer / faucet, `100` = Federal Reserve, `101` = Treasury, `N` = state agent at FIPS `N` (MA=25, CA=6, TX=48, NY=36, FL=12, IL=17, WA=53, AK=2).
- Deterministic, reproducible across deploys.
- Phase 0 produced [`scripts/derive-wallets.sh`](../scripts/derive-wallets.sh) which re-derives the full hierarchy from `MASTER_SEED` via `cast wallet private-key`. Output is pasted into `.env.local` (gitignored). Phase 1 should replace this with runtime derivation via `viem`'s `mnemonicToAccount(seed, { addressIndex })` — `.env.local` then carries only `MASTER_SEED`, not 22 extra `WALLET_*_*` lines.
- All wallets pre-funded from a faucet operator wallet during Phase 3 deployment.
- Production-grade: would use per-agent KMS or per-agent CDP Server Wallets, but for a 7-day testnet demo, the seed approach is appropriate and clearly documented.

### Pinned versions and Phase 0 gotchas

Concrete things Phase 0 surfaced that future-you (or another agent reading
this doc) WILL trip on if you don't honor them. Full builder-experience log
is in [FEEDBACK.md](../FEEDBACK.md).

| Concern | Required setting / workaround |
|---|---|
| `protobuf` Python package | Pin **`protobuf<6`** (we run 5.29.6). The `a2a` lib's `proto_utils.py` calls the removed `field.label`. Without this pin, every A2A `SendMessage` returns JSON-RPC `-32603` `'FieldDescriptor' object has no attribute 'label'`. |
| `sse_starlette` Python package | **Must `pip install sse_starlette` separately.** AXL's `integrations/pyproject.toml` underdeclares this transitive — `python -m a2a_serving.a2a_server --help` crashes on import without it. |
| Go toolchain for AXL build | **Go 1.25.5** (pinned by `vendor/axl/Makefile` via `GOTOOLCHAIN=go1.25.5`). Brew's Go 1.26 is fine because Go auto-fetches the pinned toolchain — but only if `go env GOTOOLCHAIN` returns `auto` (the default). gvisor refuses to build directly on Go 1.26. |
| AXL `tcp_port` across nodes | **Same on every node**, including same-machine ones. Public AXL docs say to differ them; that's wrong — `api/send.go`'s `dialPeerConnection` uses the local node's `TCPPort` as the *destination* port. gVisor TCP is virtual per-process so there's no host-port collision. Default `7000` on all nodes. |
| Local 2-node peering config | One node `Listen`s on `tls://127.0.0.1:9001`, the other lists that as a `Peers` entry. The public get-started example omits `Listen`/`Peers` for the second node, leaving both with empty peer lists. |
| Yggdrasil → gVisor TCP settle | After `/topology` reports a peer, allow **3-6s** before the first `/send` — TLS link is up but the gVisor TCP listener may briefly refuse. Retry with backoff. |
| MCP SDK transport for Bun | Use **`WebStandardStreamableHTTPServerTransport`**, not the Node-only `StreamableHTTPServerTransport`. Its `handleRequest(req: Request): Promise<Response>` drops directly into `Bun.serve({ fetch })`. |
| MCP SDK stateless transport | When `sessionIdGenerator: undefined`, the transport is **single-use per request** — instantiate fresh `McpServer + transport` per HTTP request. The SDK throws `"Stateless transport cannot be reused across requests"` on the second call otherwise. |
| Python integration startup order | AXL node → MCP router → MCP server → A2A server → caller. The bundled A2A server fetches `/topology` synchronously on startup to learn its own peer ID. |
| MCP `tools/call` response shape | Result is `{ content: [{ type: 'text', text: '<json string>' }] }` with the inner JSON-stringified (escaped quotes inside `text`). Parse, don't grep raw. |

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

The frontend doesn't need its own AXL node per agent — it needs to *see* the mesh. The observer is a peer that registers an MCP server with the standard `share_economic_indicator` tool so the agent fan-outs naturally include it, then serves a normalized view to the frontend. This keeps the frontend simple (WebSocket consumer) and means the AXL participation is genuinely peer-to-peer (the observer is just another peer).

### Why 8-10 deep agents and not 50

The "all 50 states" framing is what makes this *narratively* powerful. The "8-10 deep" choice is what makes it *technically* feasible. Resolution: **every agent is LLM-driven and persona-driven** (the thesis collapses if observers are dumb rules) — the difference is model tier and initiative scope. The 8-10 deep agents run on Claude Opus 4.7, have hand-tuned personas, full primitive support, and initiate complex strategies (coalitions, multi-leg swaps, bond auctions). The other 40 observer-class agents run on Claude Haiku 4.5, still have state-specific personas, broadcast their state's data, and reason over incoming proposals (accept / reject / counter), but don't initiate large-scale strategies. Cost: deep agents ~$2-5/day total, observers ~$5-10/day total — both via OpenRouter. Rule-based logic is a cost-emergency fallback only.

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
- [ ] Documentation of how MCP, A2A, and our app-level broadcast/convergecast patterns are used (the protocol-layering story; "GossipSub" is not an AXL primitive — broadcasts are MCP fan-outs)
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
| AXL has rough edges, mesh unstable | ~~Medium~~ → Low (Phase 0 + Phase 1 cleared) | Phase 0 spikes green; Phase 1 mesh sustaining with all 4 gate tests passing. Pinned-version gotchas captured under [Pinned versions and Phase 0 gotchas](#pinned-versions-and-phase-0-gotchas). |
| Bundled Python A2A server too thin for our skills | ~~Medium~~ → Resolved (Phase 1 ✅) | Custom TS A2A server shipped — [`packages/agent/src/a2a/server.ts`](../packages/agent/src/a2a/server.ts) hosts the multi-turn `Working → InputRequired → Completed` lifecycle on `Bun.serve` + `@a2a-js/sdk` `JsonRpcTransportHandler`. AXL forwards `a2a_addr` to it. |
| `/topology.tree` lags for non-hub nodes | ~~Medium~~ → Resolved (Phase 1 ✅) | Yggdrasil's spanning tree is eventually-consistent; non-hub agents under-report the mesh for several minutes. Routing works regardless. Phase 1 layered an `share_topology` MCP tool + `MeshDiscovery` 1-hop gossip loop on top, which converges in ≤10s and bridges the gap without changing AXL. See [`packages/agent/src/discovery.ts`](../packages/agent/src/discovery.ts). |
| Unichain Sepolia RPC flaky during demo | Medium | Pre-seed pools and balances before demo. Have backup recording of working demo as failsafe. |
| 0G testnet down during minting | Low-medium | Mint Phase 5, not Phase 7. Have backup of pre-minted iNFT data ready. |
| Claude rate limits hit on demo | Low | 8 deep agents at 1hr tick is well under limits. Pre-warm caches. Phase 2 swapped to OpenRouter presets so model can be downgraded (Gemini 3 Flash today) without code changes. |
| Frontend deck.gl performance at 50 states + arcs | Medium | Throttle arc animations, only render arcs for last 30s of swaps. |
| FRED/BLS API key revoked or rate-limited | ~~Low~~ → ~Low (Phase 2 hardened) | Phase 2 ships single shared ingestion service with serial-chain rate limiter (1 req/sec), 429/5xx retry-with-backoff, in-memory + disk cache. Last-known values served from cache when upstream is unreachable; agents skip the broadcast tick rather than fake data. |
| Token-bucket rate limiter over-issued requests under concurrency | ~~Surfaced in Phase 2~~ → Resolved (Phase 2 ✅) | Concurrent waiters each refilled and resolved without checking tokens, leaking ~5 req/sec at a configured 1.33 → wall of FRED 429s on first refresh. Replaced with serial promise-chain min-interval limiter ([`packages/data-plane/src/rate-limit.ts`](../packages/data-plane/src/rate-limit.ts)). |
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
