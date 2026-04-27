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

**Phase 0 complete** (2026-04-27). All AXL/MCP/A2A spikes green; data &
chain spikes scaffolded and waiting on credentials and funded wallets.
See [docs/PHASE0_REPORT.md](./docs/PHASE0_REPORT.md).

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
├── packages/                (Phase 1+) — Bun/TS workspace for agents, data plane,
│                            observer, frontend
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

# 6. Verify the foundation (Phase 0 spikes)
./spikes/00-axl-nodes/run.sh
./spikes/01-axl-mcp/run.sh
./spikes/02-axl-a2a/run.sh
```

Subsequent spikes (`03`-`06`) need credentials/funded wallets — see
[docs/PHASE0_REPORT.md](./docs/PHASE0_REPORT.md#whats-needed-to-take-spikes-3-6-from-skip-to-pass).

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
