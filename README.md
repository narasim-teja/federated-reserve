# Federated Reserve

> A peer-to-peer mesh of sovereign AI state-treasurers running on real
> public data, with real capital onchain, auditable against the actual
> decisions of human policymakers.

50 AI agents, one per US state, plus a Federal Reserve agent and a Treasury
agent. Each is a sovereign node running its own AXL peer. They ingest real
public economic data (FRED, BLS, BEA, NOAA, GDELT), reason over their
state's economic position, and negotiate bilateral and multilateral capital
flows directly with each other — no central coordinator. Decisions settle
as real swaps on Unichain via the Uniswap Trading API. Memory and learned
strategy persist to 0G Storage. Each headline state-agent is minted as an
ERC-7857 iNFT — a transferable, ownable AI policymaker.

Full vision: [docs/PROJECT.md](./docs/PROJECT.md). Architecture and seven-day
plan: [docs/TECHNICAL.md](./docs/TECHNICAL.md).

## Status

**Phase 1 complete** (2026-04-27). 3-agent local mesh (MA/CA/TX) running
the protocol stack end-to-end:

- MCP unicast — `query_treasury` peer→peer over AXL
- App-level broadcast — `share_economic_indicator` fanned out to all peers
  (AXL has no native pubsub; we fan out at the application layer over MCP)
- A2A multi-turn — `negotiate-bilateral-swap` task lifecycle
  `Working → InputRequired → Completed` over a custom TS A2A server built
  on `@a2a-js/sdk` (replaces the bundled Python `a2a_serving` which is
  single-shot only)

See [docs/PHASE1_REPORT.md](./docs/PHASE1_REPORT.md). Phase 0 outcomes in
[docs/PHASE0_REPORT.md](./docs/PHASE0_REPORT.md).

## Repo layout

```
federated-reserve/
├── docs/                    Vision, architecture, phase plans
├── vendor/axl/              AXL Go binary (cloned + built from gensyn-ai/axl)
├── .venv/                   Python venv with AXL Python integrations
├── .keys/                   ed25519 keys for AXL nodes (gitignored)
├── .env, .env.local         Real env values (gitignored)
├── .env.example             Onboarding template
├── scripts/derive-wallets.sh Re-derives the agent wallet hierarchy
├── spikes/                  Phase 0 dependency spikes (00 through 06)
├── FEEDBACK.md              Builder-experience notes (Uniswap track requirement)
├── packages/                Bun/TS workspace
│   ├── shared/              State metadata, MCP Zod schemas, A2A skill types
│   └── agent/               Per-agent runtime (MCP server + A2A server + tick loop)
├── mesh/configs/            AXL node configs for the local 3-agent mesh
├── scripts/                 Mesh runner + Phase 1 test harness
│   ├── run-local-mesh.sh    boots 3 AXL + 3 MCP routers + 3 agents
│   ├── test-mcp-unicast.sh
│   ├── test-mcp-broadcast.sh
│   └── test-a2a-negotiate.sh
├── contracts/               (Phase 3+) — Foundry project for StateToken,
│                            BondToken, ERC-7857 iNFTs
└── deploy/                  (Phase 6+) — Docker / Fly.io configs
```

## Bootstrapping a fresh checkout

```bash
# 1. Toolchain (idempotent — skip what you already have)
brew install go bun foundry openssl

# 2. Build AXL
git clone https://github.com/gensyn-ai/axl vendor/axl
cd vendor/axl && make build && cd ../..

# 3. Python integrations
python3 -m venv .venv
source .venv/bin/activate
pip install -e vendor/axl/integrations
pip install sse_starlette 'protobuf<6'   # see FEEDBACK.md for why

# 4. Generate ed25519 keys for AXL nodes
openssl genpkey -algorithm ed25519 -out .keys/node-a.pem
openssl genpkey -algorithm ed25519 -out .keys/node-b.pem

# 5. Env: copy template, fill in values
cp .env.example .env.local
# Edit .env.local — add OPENROUTER_API_KEY, FRED_API_KEY, UNISWAP_API_KEY,
# and a fresh BIP-39 mnemonic for MASTER_SEED. Then:
./scripts/derive-wallets.sh >> .env.local   # populates the WALLET_*_ADDRESS / _PRIVATE_KEY block

# 6. Workspace install
bun install

# 7. Verify the foundation (Phase 0 spikes)
./spikes/00-axl-nodes/run.sh
./spikes/01-axl-mcp/run.sh
./spikes/02-axl-a2a/run.sh
```

Subsequent Phase 0 spikes (`03`-`06`) need credentials/funded wallets — see
[docs/PHASE0_REPORT.md](./docs/PHASE0_REPORT.md#whats-needed-to-take-spikes-3-6-from-skip-to-pass).

## Running the Phase 1 mesh

```bash
# Boot 3 AXL nodes + 3 MCP routers + 3 agents (MA, CA, TX) in the foreground
./scripts/run-local-mesh.sh

# In a second terminal, run the three Phase 1 gate tests:
./scripts/test-mcp-unicast.sh        # CA → MA query_treasury
./scripts/test-mcp-broadcast.sh      # CA → {MA,TX} share_economic_indicator
./scripts/test-a2a-negotiate.sh      # CA ↔ MA negotiate-bilateral-swap

# When done, Ctrl+C the mesh (or in a new terminal: ./scripts/run-local-mesh.sh stop)
```

Logs land in `/tmp/federated-reserve/{axl,router,agent}-*.log`.

## Three hackathon tracks

This repo targets three prize tracks with one codebase, each load-bearing for
a different layer:

- **AXL (primary)** — federation-of-states is literally peer-to-peer. Each
  state-agent is a separate AXL node. No central broker.
- **Uniswap** — every economic decision settles as a real onchain swap.
- **0G** — agent memory + decision history on 0G Storage, deep state-agents
  minted as ERC-7857 iNFTs on 0G Chain.

## License

Hackathon submission, no license declared yet. Will be MIT or Apache-2.0
post-hackathon.
