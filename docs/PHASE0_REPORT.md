# Phase 0 Report — Spike Outcomes

> Day 0 dependency-validation spikes per [TECHNICAL.md §Phase 0](./TECHNICAL.md#phase-0--spike-day-0-half-day-4-6-hours).
> Generated 2026-04-27.

## TL;DR

**The mesh works.** All three AXL-related spikes (0, 1, 2) pass end-to-end —
two real AXL nodes peer locally, route MCP through `@modelcontextprotocol/sdk`
on Bun, and route A2A through the bundled Python A2A server. The
load-bearing architectural decision (AXL as transport binding under MCP and
A2A) is validated.

**The data and chain spikes are scaffolded** but gated on credentials and
funded wallets. They SKIP cleanly with helpful messages until those land.

| # | Spike | Status | Gate |
|---|---|---|---|
| 00 | AXL two-node peer + send/recv | ✅ PASS | — |
| 01 | MCP-over-AXL (`@modelcontextprotocol/sdk` on Bun) | ✅ PASS | — |
| 02 | A2A-over-AXL (bundled Python A2A server) | ✅ PASS | — |
| 03 | Uniswap Trading API `/v1/quote` | ⏸ SKIP | `UNISWAP_API_KEY` |
| 04 | FRED API state-series fetch | ⏸ SKIP | `FRED_API_KEY` |
| 05 | 0G testnet ERC-721 deploy | ⏸ SKIP | Fund deployer on 0G |
| 06 | Unichain Sepolia ERC-20 deploy | ⏸ SKIP | Fund deployer on Unichain Sepolia |

## What's already on disk

```
federated-reserve/
├── docs/                    PROJECT.md, TECHNICAL.md, PHASE0_REPORT.md
├── vendor/axl/              Cloned + built — node binary at vendor/axl/node
├── .venv/                   Python venv with mcp_routing + a2a_serving installed
├── .keys/                   ed25519 PEMs for spike 00/01/02 (gitignored)
├── .env, .env.local         Real wallet keys + placeholders for API keys
├── .env.example             Template for onboarding
├── scripts/derive-wallets.sh Re-derives the agent wallet hierarchy from MASTER_SEED
├── spikes/
│   ├── README.md
│   ├── 00-axl-nodes/        ✅ green
│   ├── 01-axl-mcp/          ✅ green (Bun + @modelcontextprotocol/sdk)
│   ├── 02-axl-a2a/          ✅ green (Python A2A bundled)
│   ├── 03-uniswap-quote/    ⏸ scaffolded
│   ├── 04-fred-series/      ⏸ scaffolded
│   ├── 05-0g-erc721/        ⏸ scaffolded
│   └── 06-unichain-erc20/   ⏸ scaffolded
└── FEEDBACK.md              Builder feedback on AXL/Uniswap/0G (Uniswap requirement)
```

## Wallet hierarchy

Generated via `cast` from a fresh BIP-39 mnemonic. All testnet only.

| Index | Role | Address |
|---|---|---|
| 0 | Deployer / faucet | `0xB3B3b1F641295D57648B277737d67B1374071713` |
| 100 | Federal Reserve | `0xe68fa8ad1FA2a516a0Fda82228Fd40Bf92B75224` |
| 101 | Treasury | `0x70F602b7fAD4d96309536B443c4784B0D19bFf89` |
| 25 (FIPS) | Massachusetts | `0x2926E2afC40a62829960C002eEe8F54eb4cEAC88` |
| 6 | California | `0xd842DEB4dbD49DD5e349a6959d8F6ee179726249` |
| 48 | Texas | `0x6966b648c8F9F1B1Be96b4A89381651a0020cE8c` |
| 36 | New York | `0x35755018070DE86339C00c04304C5D74408D700C` |
| 12 | Florida | `0x210b16F6516278Ce9decE09664FF3225E2fF0aa2` |
| 17 | Illinois | `0xFF09b3C7DDCf9b04B99dFcFE5818E9A2526F6088` |
| 53 | Washington | `0x1cb0C85d73058370C03d1f7cf29488Ffe3Eb2f52` |
| 2 | Alaska | `0xf79182429761F6Bd5D1CabF263F448AE2bdea889` |

Re-derive any time with `scripts/derive-wallets.sh`.

## Architectural validations

### AXL is a transport binding (confirmed)

Spike 01 demonstrates the load-bearing thesis: the official
`@modelcontextprotocol/sdk` server on Bun is reachable from a peer over
real AXL transport with zero custom protocol code. Spike 02 shows the same
thing via the A2A wrapping. Both round-trip correctly. The architectural
choice in TECHNICAL.md ("MCP defines the tools, A2A defines the agents,
AXL makes them reachable") is real.

### Bun + Web Standards are the right glue (confirmed)

The MCP SDK ships `WebStandardStreamableHTTPServerTransport` whose
`handleRequest(req: Request): Promise<Response>` drops directly into
`Bun.serve({ fetch })`. Total integration code: ~80 lines for a working
MCP server with a real tool, registration with the AXL bridge, and clean
shutdown. No Node http shimming needed.

### The bundled A2A server is too thin for our Phase 1+ needs (heads-up)

`a2a_serving.a2a_server` auto-derives A2A skills from registered MCP
services as request/response wrappers. It can't host first-class A2A
skills with rich task lifecycles (`Working → InputRequired → Completed`)
that TECHNICAL.md describes for `negotiate-bilateral-swap` etc. **Action
for Phase 1:** plan a TS A2A server using `@a2a-js/sdk` that we point AXL
at via `a2a_addr`, replacing the bundled Python one.

## What's needed to take spikes 3-6 from SKIP to PASS

For the user to populate (everything else is on disk):

1. **`OPENROUTER_API_KEY`** — sign up at https://openrouter.ai (Phase 2 dep,
   not required for Phase 0 spikes but in the env template).
2. **`UNISWAP_API_KEY`** — Uniswap Developer Platform.
3. **`FRED_API_KEY`** — free at https://fred.stlouisfed.org/docs/api/api_key.html
4. **`BLS_API_KEY`** — free at https://www.bls.gov/developers/
5. **0G testnet funds** for `0xB3B3b1F641295D57648B277737d67B1374071713` —
   https://faucet.0g.ai
6. **Unichain Sepolia funds** for the same address — Sepolia faucet then
   Unichain bridge, or a direct Unichain Sepolia faucet.

Then re-run any of the four gated spikes.

## How to re-run any spike

```bash
./spikes/00-axl-nodes/run.sh
./spikes/01-axl-mcp/run.sh
./spikes/02-axl-a2a/run.sh
./spikes/03-uniswap-quote/run.sh
./spikes/04-fred-series/run.sh
./spikes/05-0g-erc721/run.sh
./spikes/06-unichain-erc20/run.sh
```

Each `run.sh` has a `stop` subcommand that kills any leftover background
processes (AXL nodes, Python services, MCP servers).

## Notable findings (full list in [FEEDBACK.md](../FEEDBACK.md))

1. **`tcp_port` docs guidance is wrong** — public AXL docs say to use
   different `tcp_port` on same machine; this breaks `/send` because the
   dialer uses the local node's port as the destination port.
2. **MCP SDK stateless transport is single-use** — must instantiate fresh
   server + transport per request when `sessionIdGenerator: undefined`.
3. **`a2a` Python lib is incompatible with protobuf ≥ 6** — uses
   `field.label` which was removed; pin `protobuf<6`.
4. **`a2a_serving.a2a_server` requires AXL to be up first** — fetches
   `/topology` synchronously on startup.
5. **Python integrations under-declare deps** — fresh
   `pip install -e vendor/axl/integrations` doesn't pull `sse_starlette`.

## Ready for Phase 1

The gate is "AXL works at all" → **passed.** Phase 1 (mesh foundation)
can begin building the real `packages/` monorepo on top of these proven
foundations.
