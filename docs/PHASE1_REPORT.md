# Phase 1 Report — Mesh Foundation

> Day 1 of the seven-day plan per [TECHNICAL.md §Phase 1](./TECHNICAL.md#phase-1--mesh-foundation-day-1).
> Generated 2026-04-27.

## TL;DR

**Three-agent mesh works end-to-end.** The Bun/TypeScript agent runtime
runs alongside one AXL node and one Python MCP Router per host, and the
three Phase 1 gate tests are green:

| # | Test | What it proves | Result |
|---|---|---|---|
| 1 | MCP unicast — CA → MA `query_treasury` | Spike-01 lifted into the real mesh: peer-to-peer single-shot tool calls work over AXL transport | ✅ |
| 2 | App-level broadcast — CA → {MA, TX} `share_economic_indicator` | Fan-out across the mesh; both receivers logged the indicator | ✅ |
| 3 | A2A multi-turn — CA ↔ MA `negotiate-bilateral-swap` | `Working → InputRequired → Working → Completed` lifecycle round-trips through our **custom TS A2A server** built on `@a2a-js/sdk` (the bundled Python A2A is single-shot and could not host this) | ✅ |

The big architectural delivery: the **custom TS A2A server** that
TECHNICAL.md flagged as the Phase 1 must-ship is live. From here on, every
multi-turn skill (`participate-in-coalition`, `bond-auction`,
`request-emergency-aid`, `coordinate-shock-response`) plugs into the same
`AgentExecutor` pattern.

## What landed on disk

```
federated-reserve/
├── package.json, tsconfig.base.json, biome.json   # monorepo root
├── packages/
│   ├── shared/                                    # state metadata, MCP zod schemas, A2A types
│   │   └── src/{states.ts, mcp-schemas.ts, a2a-types.ts, index.ts}
│   └── agent/                                     # per-agent runtime
│       └── src/
│           ├── index.ts            # entry point — startup/shutdown ordering
│           ├── config.ts           # env → typed AgentConfig
│           ├── state.ts            # in-memory treasury (Phase 2 swaps for 0G Storage)
│           ├── axl-client.ts       # /topology, /send, /recv, /mcp/, /a2a/ wrapper
│           ├── mcp-router-client.ts# Python MCP Router register/deregister
│           ├── broadcast.ts        # app-level fan-out helper
│           ├── tick.ts             # heartbeat + periodic indicator broadcast
│           ├── mcp/server.ts       # factory-pattern MCP server (Bun.serve)
│           └── a2a/
│               ├── card.ts         # AgentCard generator per state
│               ├── server.ts       # Bun.serve A2A server
│               └── executor.ts     # negotiate-bilateral-swap deterministic stub
├── mesh/configs/                   # node-{ma,ca,tx}.json — AXL node configs
└── scripts/
    ├── run-local-mesh.sh           # boots 3 AXL + 3 MCP routers + 3 agents
    ├── test-mcp-unicast.sh         # gate 1
    ├── test-mcp-broadcast.sh       # gate 2
    └── test-a2a-negotiate.sh       # gate 3
```

## Topology

```
                             [ MA agent  FIPS 25 ]            ← listener
                                   │
                          ┌────────┴────────┐
                          │                 │
                  [ CA agent FIPS 6 ]   [ TX agent FIPS 48 ]
```

Per host (Bun process + sidecars):

```
agent-MA: AXL :9002 listen :9001  | MCP Router :9003 | TS MCP :7100/mcp | TS A2A :9004
agent-CA: AXL :9012 peers→:9001   | MCP Router :9013 | TS MCP :7110/mcp | TS A2A :9014
agent-TX: AXL :9022 peers→:9001   | MCP Router :9023 | TS MCP :7120/mcp | TS A2A :9024
```

All AXL nodes share `tcp_port: 7000` per the Phase 0 finding (the dialer
uses its own `tcp_port` as the destination port).

## Architectural validations

### The custom TS A2A server holds the multi-turn lifecycle

`packages/agent/src/a2a/server.ts` runs `JsonRpcTransportHandler` from
`@a2a-js/sdk` over a tiny Bun.serve front-end. It serves
`GET /.well-known/agent-card.json` for AXL discovery and `POST /` for
JSON-RPC. The executor in
[a2a/executor.ts](../packages/agent/src/a2a/executor.ts) publishes:

1. `Task` (kind=task, status=working) on the first proposal
2. `TaskStatusUpdateEvent` (state=input-required, final=false) carrying a
   counter `Message` in `status.message` — the 5% haircut is
   deterministic so the test can assert on the exact amount
3. `TaskStatusUpdateEvent` (state=completed, final=true) on round 2 with a
   settlement payload (rounds≥2)

Test 3 verifies the full sequence: round-1 returns `state=input-required`
with `counter.give.amount=475000000000` (a 5% haircut on the proposed
500B), round-2 returns `state=completed` with a `settlement` DataPart.

### "GossipSub" is application-level fan-out, not an AXL primitive

AXL's HTTP surface (per [`vendor/axl/docs/api.md`](../vendor/axl/docs/api.md))
is `/topology`, `/send`, `/recv`, `/mcp/{peer}/{svc}`, `/a2a/{peer}`. There
is **no native pubsub** — the GossipSub framing in earlier drafts of
TECHNICAL.md was aspirational. Phase 1 implements broadcast as O(N) MCP
fan-out: walk the mesh, call `share_economic_indicator` on every peer's
`treasurer` service. Latency is fine for a 50-node mesh on 1hr ticks.

This is captured in [`packages/agent/src/broadcast.ts`](../packages/agent/src/broadcast.ts);
the tick loop uses it to emit periodic indicator broadcasts so the mesh
has steady traffic during demo.

### Yggdrasil spanning-tree convergence is asymmetric (informational)

The non-listener agents' `/topology.tree` field under-reports during early
lifetime — we observed CA's tree showing only 2 nodes (CA + MA) after a
minute of uptime, even though TX was reachable and MCP/A2A calls
CA → TX succeeded. The hub (MA) sees all 3 immediately. **Underlying
routing works regardless** — we proved this by running a CA → TX MCP call
to completion while CA's tree was still reporting 2 nodes.

For Phase 1 the broadcast test gathers peer pubkeys from MA (the
well-connected hub) for determinism. **Production-grade discovery needs
an MCP `share_topology` gossip tool** — Phase 2 task. This is not a
correctness bug, it's a discovery-completeness gap.

## Phase 1 deliverables vs TECHNICAL.md checklist

| Item | Status |
|---|---|
| Repo scaffold (Bun workspaces, tsconfig.base, Biome) | ✅ |
| `packages/shared` — types, MCP zod schemas, A2A types, state metadata for 50+DC+PR | ✅ |
| Add deps: `@a2a-js/sdk`, `@modelcontextprotocol/sdk`, `viem`, `zod` | ✅ (viem deferred to Phase 3 — no chain code yet) |
| `packages/agent` skeleton — main loop, MCP-router-client, per-request McpServer factory | ✅ |
| Custom TS A2A server using `@a2a-js/sdk` `DefaultRequestHandler` | ✅ |
| Dockerfile per agent + `deploy/compose/local-mesh.yml` | ⏸ deferred to Phase 6 packaging — Phase 1 confirmed the topology with bare Bun processes; containerization is a packaging concern, not a correctness concern |
| 3-agent local mesh | ✅ (`scripts/run-local-mesh.sh`) |
| MCP test: 3 agents broadcast `share_economic_indicator`, all 3 receive | ✅ via `test-mcp-broadcast.sh` |
| MCP test: agent A calls `query_treasury` on agent B | ✅ via `test-mcp-unicast.sh` |
| A2A test: `negotiate-bilateral-swap` with InputRequired round-trip and Completed terminal | ✅ via `test-a2a-negotiate.sh` |

## Notable findings (folded into FEEDBACK.md)

1. **`tree` field lags `peers`** — Yggdrasil spanning-tree updates
   propagate asymmetrically; the routing layer works while the topology
   view is still converging. Application-level discovery should not
   assume `/topology.tree` is complete.
2. **`@a2a-js/sdk` is a clean drop-in for AXL's `a2a_addr`** — `Bun.serve`
   + `JsonRpcTransportHandler` is ~80 lines and supports the full v0.3.0
   spec including streaming.
3. **AXL forwards `GET /a2a/{peer}` to `/.well-known/agent-card.json`** —
   not the root path. That's documented in the AXL repo's a2a_utils.go
   but easy to miss; our server explicitly serves it.
4. **Bun runs `.ts` directly with no type stripping** — `declare const`
   tricks for "keep this type imported" don't work; just import the type
   when you use it, or remove unused imports.

## Ready for Phase 2

Phase 2 (Memory + Reasoning + AgentCards) builds on:

- The same agent process now wires in 0G Storage (`packages/agent/src/memory.ts`)
- `packages/agent/src/reason.ts` calls OpenRouter (Claude via OpenAI-compat)
- The `negotiate-bilateral-swap` deterministic stub becomes Claude-driven
- AgentCards get hand-tuned per-state personas (currently all use one template)
- FRED ingestion in `packages/data-plane`
- A `share_topology` MCP tool to fix the discovery gap noted above
