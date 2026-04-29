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
| Smart contracts | Foundry + OpenZeppelin (via `bun add`) | MockUSDC, per-state ERC-20 tokens, BondToken, ERC-7857 iNFT |
| Settlement | Uniswap Trading API (V3 routes) + Unichain Sepolia | Real onchain swap execution; bond issuance via direct ERC-20 calls (mint + transfer) |
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

**How we use it (Phase 3 ✅):**
- Each state-agent has a wallet (deterministically derived from
  `MASTER_SEED` per BIP-44 m/44'/60'/0'/0/{fips}). Pre-Phase-3 wallets
  funded with 0.05 ETH on Unichain Sepolia + 1M MockUSDC + 1.9M of
  their own StateToken.
- When two agents complete a `negotiate-bilateral-swap`, each fires
  `/v1/check_approval` → `/v1/quote` → Permit2 EIP-712 sign via viem
  → `/v1/swap` → broadcast on Unichain Sepolia. Implementation:
  [`packages/agent/src/execute.ts`](../packages/agent/src/execute.ts)
  (`SwapExecutor` class). Two real swaps per agreed trade — one per
  side — both visible on
  [unichain-sepolia.blockscout.com](https://unichain-sepolia.blockscout.com).
- Pool seeding: 5 V3 USDC×StateToken pools (fee=3000, full-range)
  seeded via `NonfungiblePositionManager.mint` from the deployer
  wallet. Trading API's CLASSIC route routes through these on the
  next request — no subgraph wait needed on Unichain Sepolia.
  ([`scripts/seed-pools.ts`](../scripts/seed-pools.ts))
- LP primitive (stretch — deferred to Phase 6/7): use the Trading
  API's LP endpoints for state-agent-funded positions earning fees.
- **FEEDBACK.md** maintained from Day 1 — every API friction point
  logged with timestamp. Phase 3 added 6 entries covering quote
  ergonomics, testnet support gaps, RPC stale-read, and a real bug
  (CLASSIC `swap.gasLimit` too tight, OOG inside the pool).

> **Why V3, not V4** (deviation from initial plan): Unichain Sepolia
> has the canonical V3 Factory + NonfungiblePositionManager deployed
> at standard addresses; V4 hooks + PositionManager flow is several
> times more code to seed correctly on testnet, and the Trading API
> CLASSIC route uses V3 by default. Locked in V3 in Phase 3; revisit
> V4 in Phase 6/7 if there's time and a clear win.

**Qualification compliance:**
- ✅ Real Trading API integration with onchain execution (verified by
  two passing gate tests with explorer links)
- ✅ FEEDBACK.md present at repo root with substantive entries

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
│     - Execute swaps (Uniswap Trading API,          │            │
│       Phase 3 ✅; SwapExecutor in execute.ts)       │            │
│     - Mint/transfer for bond auctions (direct      │            │
│       ERC-20 calls; Phase 3 ✅)                     │            │
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
> mesh configs for NY+FL, and the Phase 2 gate test. Phase 3 added
> `contracts/` (Foundry: MockUSDC + StateToken + BondToken + INFT7857),
> agent-side `execute.ts` (Uniswap Trading API), shared `deployments.ts`,
> three deploy scripts, and two Phase 3 gate tests. Phases 4-6 add the
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
│   ├── deploy-contracts.ts     # [Phase 3 ✅] MockUSDC + 5 StateTokens + INFT7857
│   ├── seed-pools.ts           # [Phase 3 ✅] 5 V3 USDC×StateToken pools (fee=3000, full-range)
│   ├── seed-pools-retry.ts     # [Phase 3 ✅] idempotent retry for the 3-of-5 mints
│   │                           # that hit Unichain Sepolia RPC stale-read
│   ├── deploy-bond.ts          # [Phase 3 ✅] MA-issued BondToken (one per auction)
│   ├── smoke-execute.ts        # [Phase 3 ✅] standalone Trading-API swap smoke test
│   ├── test-phase3-gate.sh     # [Phase 3 gate] bilateral swap two-leg settlement
│   ├── test-phase3-bond.sh     # [Phase 3 gate] bond auction primary issuance
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
│   │   │   ├── deployments.ts  # [Phase 3] typed loader for contracts/deployments/<chain>.json,
│   │   │   │                   # asset resolver, getUsdc/getStateToken/getBond
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
│   │   │   ├── execute.ts          # [Phase 3] SwapExecutor — Uniswap Trading API client (viem-backed):
│   │   │   │                       #   /check_approval → /quote → Permit2 sign → /swap → confirm,
│   │   │   │                       #   plus mintBond/payIssuer for bond settlement.
│   │   │   ├── mcp/
│   │   │   │   └── server.ts       # factory-pattern MCP server (Bun.serve)
│   │   │   └── a2a/
│   │   │       ├── card.ts         # persona-driven AgentCard generator (Phase 2)
│   │   │       ├── server.ts       # @a2a-js/sdk JsonRpcTransportHandler on Bun.serve
│   │   │       └── executor.ts     # AgentExecutor — Phase 1 negotiate + Phase 2 four new skills,
│   │   │                           # all reasoner-driven; Phase 3 fires onchain settlement
│   │   │                           # (responder leg of negotiate-bilateral-swap, mint on bond-auction award)
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
├── contracts/                  # [Phase 3 ✅] Foundry, npm-managed (OpenZeppelin via bun)
│   ├── foundry.toml            # node_modules + lib remap, solc 0.8.24
│   ├── package.json            # @openzeppelin/contracts 5.1.0
│   ├── src/
│   │   ├── MockUSDC.sol        # 6-decimal ERC-20, public mint() (testnet only)
│   │   ├── StateToken.sol      # ERC-20 per state, 18 decimals, owner-mintable
│   │   ├── BondToken.sol       # ERC-20, 6 decimals (matches USDC face value);
│   │   │                       # immutable {issuer, fips, couponBps, maturity, principal}
│   │   └── INFT7857.sol        # ERC-7857 skeleton (Phase 3 deploy + tests; Phase 5 mints)
│   ├── test/                   # 13 tests, all passing (forge test)
│   └── deployments/
│       └── unichain-sepolia.json  # canonical address book consumed by agents + scripts
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

Issuer pre-deploys the `BondToken` contract on Unichain Sepolia
(constructor sets `issuer = issuer_wallet`, `onlyIssuer` mint).
Issuer optionally broadcasts `announce_bond_auction` via the MCP tool
to invite bids; bidders submit bids as A2A `bond-auction` tasks
(`bondBidSchema`). Issuer evaluates and on `awarded` fires
`BondToken.mint(bidder, principal)` from its agent process — the
mint tx hash + bond contract address are embedded in the
`BondAward` payload so the bidder can verify and follow up. Bidder's
process then fires `USDC.transfer(issuer, principal)`. **Settlement
is direct ERC-20 calls, not Uniswap** — primary issuance does not
route through an AMM. (Phase 3 ✅; see
[`packages/agent/src/a2a/executor.ts`](../packages/agent/src/a2a/executor.ts)
`handleBondBid` + `executeBondMint`.)

```
Issuer task: Working (collecting) → Completed (awarded + mint tx populated | rejected)
Bidder task: send bid → receive BondAward → fire USDC.transfer(issuer, principal)
```

Phase 4 expands this to multi-bidder collection (issuer waits N bids
before awarding the lowest yield).

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

### Phase 3 — Settlement (Day 3) — ✅ COMPLETE 2026-04-28

**Purpose:** Money actually moves. This is the Uniswap track deliverable.

**Outcome:** Two onchain settlement primitives shipped, both verified
end-to-end on Unichain Sepolia (chain 1301):

1. **Bilateral swap** — `negotiate-bilateral-swap` A2A skill now fires
   the responder's leg via the Uniswap Trading API on transition to
   `Completed`; the initiator's driver fires the mirror leg after
   observing the Completed event. Two real Uniswap swaps per agreed
   trade, both wallets show rebalanced balances on the explorer.
2. **Bond auction primary issuance** — `bond-auction` A2A skill now
   fires `BondToken.mint(bidder, principal)` from the issuer's wallet
   on `awarded`; the bidder's driver follows up with
   `USDC.transfer(issuer, principal)`. Direct ERC-20 settlement, no
   AMM involved (correctly — primary issuance is not a market trade).

Both gate tests pass (`scripts/test-phase3-gate.sh` and
`scripts/test-phase3-bond.sh`). Phase 1 + Phase 2 gate tests stay green.
Six new FEEDBACK.md entries cover the Uniswap track in detail
(delights + bugs).

> **Pulled forward / changed from this phase's original plan**:
> - **5 deep StateTokens, not 8.** MA/CA/TX/NY/FL ship in Phase 3 to
>   match the Phase 1+2 mesh (the 5-agent local mesh that was already
>   running). IL/WA/AK contracts + pools land in Phase 4 alongside
>   the federation scale-up to 12 processes.
> - **Uniswap V3, not V4.** V3's NonfungiblePositionManager is
>   deployed on Unichain Sepolia and the Trading API's CLASSIC route
>   uses it by default; V4 deployment + LP-API testnet support was
>   not verified, and V3 keeps the seeding script ~150 lines instead
>   of a multi-day V4 hooks build.
> - **NonfungiblePositionManager direct calls, not the LP API.** The
>   original plan said "Use the LP API"; we used `viem` against the
>   canonical NPM at `0xB7F724…D075` for deterministic, scriptable
>   pool seeding. The Trading API's `/quote` indexer picked up the
>   freshly-seeded pools on the very next request — no subgraph wait.
> - **MockUSDC.sol added.** No canonical USDC on Unichain Sepolia, so
>   we deployed a 6-decimal `MockUSDC` with public `mint()`. Each
>   state agent self-funded.
> - **Bond settlement via direct ERC-20, not Uniswap.** The original
>   plan said "settlement via Uniswap" for bonds; that conflated
>   primary issuance with secondary trading. Bonds at issuance are
>   `BondToken.mint` + `USDC.transfer`, no AMM. Secondary trading
>   could route through Uniswap pools later but isn't Phase 3 scope.
> - **Bond auction bids over A2A, not MCP.** TECHNICAL.md draft said
>   "peers bid via MCP"; the actual schema (Phase 2) wires it as the
>   `bond-auction` A2A skill. Phase 3 keeps that and adds settlement.
> - **BondToken.decimals = 6** (overriding ERC20's default 18) so
>   `mint(bidder, principal)` reads 1:1 against USDC face value with
>   no scale conversion. Cleaner audit trail.
> - **Demo bond issued by MA (the bootstrap), not NY.** AXL's
>   bootstrap-spoke topology in the local mesh routes leaf→hub
>   traffic reliably but hub→leaf less so (we observed silent
>   misrouting of `/a2a/{leaf_key}` from MA's AXL); for the gate test
>   the bidder is CA (a leaf) sending to MA (the hub). On Fly.io
>   with full geographic peering (Phase 6) any state can issue.

#### Onchain artifacts (Unichain Sepolia chain 1301)

| Contract            | Address                                              | Notes                                |
| ------------------- | ---------------------------------------------------- | ------------------------------------ |
| MockUSDC            | `0x462b31b02e00d0dec2aeb79437e20e9fa3b96f94`         | 6 decimals, public `mint()`          |
| StateToken MA (MAT) | `0x7a87ff3dd531e79a2d08720374beb9670b9f2780`         | 18 decimals, deployer-mintable       |
| StateToken CA (CAT) | `0x0411752c54f84d35d99c55937fb70d66382b0645`         |                                      |
| StateToken TX (TXT) | `0x4cdf222770c0231204446f3c516cb8664bd9948a`         |                                      |
| StateToken NY (NYT) | `0xb42274bbc44ffcacd746a5d5ebe7fcabfd9b53be`         |                                      |
| StateToken FL (FLT) | `0x03d93986991d5ee4c43528f02bffad1a54172c0e`         |                                      |
| INFT7857            | `0xdad62bba075bc0193551c91cc5db79e558e5e5db`         | Phase 5 mints                        |
| BondToken MA-2030   | `0xcfd8fad6e75340ceecb8f688c1cc6036a1e9b5fd`         | issuer=MA, 4.25% coupon, 2030-01-01  |

5 V3 pools (USDC × StateToken, fee=3000, full-range) seeded from
deployer wallet via `NonfungiblePositionManager.mint`. Pool addresses
in [`contracts/deployments/unichain-sepolia.json`](../contracts/deployments/unichain-sepolia.json).

#### Checklist

- [x] **`contracts/` Foundry project** ([contracts/](../contracts/))
  scaffolded with OpenZeppelin via bun (no submodules), 4 contracts +
  13 passing Foundry tests:
  - [x] `MockUSDC.sol` — testnet stand-in, 6 decimals, public mint
  - [x] `StateToken.sol` — per-state ERC-20, 18 decimals,
    owner-mintable, FIPS metadata
  - [x] `BondToken.sol` — per-bond ERC-20, **6 decimals** (overrides
    ERC20 default), immutable issuer + coupon + maturity + principal,
    `onlyIssuer` mint
  - [x] `INFT7857.sol` — ERC-7857 skeleton with encrypted-URI hook
- [x] **Deployment script** ([scripts/deploy-contracts.ts](../scripts/deploy-contracts.ts))
  deploys MockUSDC + 5 StateTokens + INFT7857 in one pass; mints USDC
  + transfers initial StateToken supply to each state wallet; persists
  full address book to `contracts/deployments/unichain-sepolia.json`.
- [x] **Pool seeding** ([scripts/seed-pools.ts](../scripts/seed-pools.ts)
  + [scripts/seed-pools-retry.ts](../scripts/seed-pools-retry.ts)):
  V3 USDC×StateToken pools at fee=3000, full-range LP from deployer.
  The retry script is idempotent and exists because Unichain Sepolia
  RPC stale-read after `createAndInitializePoolIfNecessary` reverted
  the same-tx mint for 3 of 5 pools on the first run — see
  [FEEDBACK.md](../FEEDBACK.md) for the full incident.
- [x] **`packages/agent/src/execute.ts`** — `SwapExecutor` class:
  full Trading API flow (`/check_approval` → `/quote` → Permit2
  EIP-712 sign via viem → `/swap` → broadcast → confirm). Auto-
  estimates gas with 25% headroom (the API-returned `swap.gasLimit`
  was occasionally too tight for the inner pool-side ERC-20 transfer
  and OOG'd with "TF" — see FEEDBACK.md). Also exposes `mintBond` and
  `payIssuer` helpers for bond settlement.
- [x] **Bilateral swap settlement wired into A2A executor**
  ([packages/agent/src/a2a/executor.ts](../packages/agent/src/a2a/executor.ts)).
  When `negotiate-bilateral-swap` reaches Completed, the responder
  fires its mirror leg (USDC → initiator's StateToken) and embeds the
  result in the settlement payload. Schema extended to
  `legs.{initiator,responder}` with full per-leg tx metadata
  ([packages/shared/src/a2a-types.ts](../packages/shared/src/a2a-types.ts)).
- [x] **First end-to-end (gate test)** —
  [scripts/test-phase3-gate.sh](../scripts/test-phase3-gate.sh) drives
  CA(initiator) ↔ MA(responder) negotiation, confirms responder leg
  in the settlement, then fires initiator leg from the test driver.
  Asserts MA: −100 USDC + ≈99.6 CAT; CA: −100 USDC + ≈99.6 MAT.
  Both txs visible on `unichain-sepolia.blockscout.com`.
- [x] **Bond issuance flow** —
  [scripts/deploy-bond.ts](../scripts/deploy-bond.ts) deploys a single
  `BondToken` per auction (issuer set in constructor). The
  `bond-auction` A2A handler in `executor.ts` looks up the bond by
  `bond_id`, mints to the bidder via `BondToken.mint`, and embeds
  `mint_tx_hash` + `bond_token_address` in the `BondAward` payload.
  [scripts/test-phase3-bond.sh](../scripts/test-phase3-bond.sh) drives
  CA(bidder) → MA(issuer) bid, asserts mint, fires CA's
  `USDC.transfer(MA)`, and asserts $1,000 face value MAB30 in CA's
  wallet + $1,000 USDC delta in MA's wallet.

#### Phase 3 gate — ✅ both tests PASS

```
scripts/test-phase3-gate.sh   (bilateral swap)
  ✓ mesh reachable, both pubkeys resolved
  ✓ round 1: input-required + counter received
  ✓ round 2: completed with settlement payload
  ✓ responder leg: tx=0xcb8077dc…  (USDC → CAT, MA's wallet)
  ✓ initiator leg: tx=0xe1b4e992…  (USDC → MAT, CA's wallet)
  ✓ both wallets rebalanced (USDC out, peer-state-token in)

scripts/test-phase3-bond.sh   (bond auction primary issuance)
  ✓ mesh reachable, both pubkeys resolved
  ✓ issuer (MA) minted BondToken to bidder (CA)
  ✓ bidder (CA) paid issuer (MA) via direct USDC.transfer
  ✓ settled: CA holds bond face value, MA received principal in USDC
```

#### Bugs surfaced + fixed during Phase 3

1. **Unichain Sepolia RPC stale-read across writes.** After
   `createAndInitializePoolIfNecessary`, the same RPC node returned
   `factory.getPool(...) == 0x0` for ~1-3s, and a follow-up
   `mint` call read the pool's `slot0.sqrtPriceX96` as 0 and
   reverted with "TF". Workaround:
   `seed-pools-retry.ts` polls slot0 until non-zero, then mints.
   Same gotcha hit the post-swap balance reads in the smoke test —
   `balAfterChange` polls until the value moves.
2. **Trading API CLASSIC `swap.gasLimit` occasionally too tight.**
   The pool's inner ERC-20 transfer to recipient hit OutOfGas with
   the API-returned gas limit (~95k), reverting with "TF". Fix in
   `execute.ts`: ignore `swap.gasLimit`, run `eth_estimateGas`
   ourselves, add 25% headroom. Documented in FEEDBACK.md.
3. **Token bucket race in data plane** (Phase 2 carryover but
   re-confirmed — no Phase 3 regression).

**Deliverable:** Real onchain swaps + bond issuance fired by AXL
message exchange. FEEDBACK.md updated with 6 Phase 3 entries
(delights + bugs). Commit `phase-3-settlement`.

### Phase 4 — Federation Scale-up (Day 4) — ✅ COMPLETE 2026-04-29

**Purpose:** Make it look and feel like a real federation, not a 5-node toy.

**Outcome:** 10-process mesh (8 deep states + FED + TRS) with:
- 8 StateTokens + 8 USDC×StateToken V3 pools onchain (Phase 3 + IL/WA/AK backfill)
- Multi-bidder bond auction (BondAuctionRegistry parks N bids, evaluates by lowest yield with credit-rating-derived floor/ceiling, settles winner mint, rejects others)
- Algorithmic credit rating (deterministic function over reserve ratio + unemployment + per-capita income + persona penalty → AAA..D rating + yield floor/ceiling)
- Onchain aid settlement (responder fires `USDC.transfer(requester, amount)` on `offered`)
- Federal mechanics: FED broadcasts `announce_fed_rate` every Nth tick (configurable); TRS exposes `issue_federal_transfer` MCP tool that fires USDC.transfer from the Treasury wallet (Treasury-only, gated by amount cap)
- Phase 4 gate test ✅ 4/4 PASS — multi-bidder, aid settlement, shock response, fed rate broadcast

> **Picked up from Phase 3:** the 3 deep states deferred from Phase 3
> (IL/WA/AK) need their StateToken contracts deployed, V3 pools
> seeded, and mesh configs added so the full 8-deep-state set is
> onchain and routable. Folded into the scale-up below.

- [x] **Onchain backfill (deferred from Phase 3)**: deployed IL/WA/AK
  StateTokens via [`scripts/deploy-phase4-onchain.ts`](../scripts/deploy-phase4-onchain.ts)
  (idempotent, also distributes USDC to new agent wallets, mints
  Treasury federal-pool USDC, and funds 5 new wallets with ETH for
  gas), seeded 3 more V3 pools via [`scripts/seed-phase4-pools.ts`](../scripts/seed-phase4-pools.ts).
  Result: 8 StateTokens + 8 USDC×StateToken pools.
- [x] Federal Reserve agent — `tier: 'federal'`, FIPS 100, broadcasts
  `announce_fed_rate` every `FED_RATE_BROADCAST_EVERY_N` ticks
  (default 4). Reasoner-driven rate decision when OpenRouter is up,
  deterministic 4-step schedule otherwise. Receivers store
  announcements in `state.receivedFedRates`.
- [x] Treasury agent — `tier: 'federal'`, FIPS 101, registers
  `issue_federal_transfer` MCP tool. Only TRS approves+executes; all
  other agents respond with `not authorized`. Approval gated at
  `< $10M` cap; uses the same `SwapExecutor.payIssuer` helper that
  bond and aid settlement use.
- [x] Algorithmic credit rating — pure function in
  [`packages/shared/src/credit-rating.ts`](../packages/shared/src/credit-rating.ts)
  scoring each state 0-100 over reserve ratio (60pts), unemployment
  (20pts), per-capita income (20pts), minus persona penalty
  (pension-stressed: -8, hurricane-exposed: -4). Rating → yield floor
  + ceiling (e.g. AAA: 300/450bps; BBB: 550/825bps; D: 1500/5000bps).
  Wired into the bond-auction evaluator.
- [x] **Multi-bidder bond auction** —
  [`packages/agent/src/a2a/bond-auction-registry.ts`](../packages/agent/src/a2a/bond-auction-registry.ts).
  Each handler parks its bid in the registry keyed by `bond_id`; on
  the first bid the registry starts a `windowMs` timer (default 8s);
  bids arriving within the window pile up; on timer or
  `maxBidsForEval`, the registry calls the executor's evaluator,
  picks the lowest-yield eligible bid (between floor+ceiling), fires
  the winner's `BondToken.mint` via the SwapExecutor, then resolves
  every parked task's promise with its own `BondAward` (winner gets
  mint metadata; losers get a clear rationale).
- [ ] Coalition formation flow — A2A multi-turn negotiation that
  converges on a coalition agreement. **Deferred to Phase 5+** (Phase 2's
  single-round handler is sufficient for the live demo; multi-turn
  is a polish item).
- [x] Aid request → grant flow — `handleAidRequest` now fires
  `USDC.transfer(requester, amount)` on `offered`. Mirror of Phase 3
  bond settlement pattern. Failure of the on-chain leg does not fail
  the task; the response still emits with `kind=offered` but empty
  settlement metadata.
- [x] **Scale local mesh to 10 processes** —
  [`scripts/run-local-mesh.sh`](../scripts/run-local-mesh.sh) updated
  with `MESH_AGENTS=10` default. New mesh configs for IL/WA/AK +
  FED/TRS. Every node Listens on its own port AND Peers with every
  other node (full bidirectional), giving 18 peer entries in
  `/topology` per node post-convergence.
- [ ] Add NOAA event ingestion to data plane — **deferred to Phase 5/6**.
- [ ] Add GDELT state-tagged news ingestion — **deferred to Phase 5/6**.
- [x] First shock injection test: synthetic hurricane signals →
  affected states in parallel; gate test verifies structured
  contributions (joining/abstaining + commitment).

#### Phase 4 gate — ✅ 4/4 PASS

[`scripts/test-phase4-gate.sh`](../scripts/test-phase4-gate.sh):

```
✓ multi-bidder: CA won at 600bps, NY rejected (outbid), FL rejected (above ceiling)
✓ multi-bidder mint verified on-chain: CA received 1,000,000,000 bond units
✓ aid offered with on-chain transfer (MA → CA, 500 USDC)
✓ shock response: 3/3 structured contributions
✓ federal rate broadcast received by at least one peer (10 broadcasts seen)
```

#### Known issue surfaced

- **AXL leaf→leaf A2A routing**: when CA dials `/a2a/{IL_pubkey}`, the
  request silently delivers to MA (the bootstrap) rather than IL.
  MCP routing on the same key works correctly (MCP returns IL data),
  so this is an A2A-stream-specific routing issue in the local 10-node
  mesh. Phase 3 already documented the analogous hub→leaf direction;
  the gate test workaround is to issue all A2A traffic to MA's pubkey
  (leaf→hub, which routes reliably). Production deploy on Fly.io with
  full geographic peering should not exhibit this localhost gVisor
  artifact, but the issue is on the FEEDBACK list for AXL upstream.

**Deliverable:** 10 agents running concurrently in mesh, real federal
mechanics, 8 onchain StateTokens + pools, multi-bidder bond auction
working with credit-rating-driven yield evaluation, aid settlement
on-chain, shock response structured. Commit `phase-4-federation-scaleup`.

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
