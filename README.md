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
- MCP gossip discovery — `share_topology` tool + 1-hop refresh loop
  bridges Yggdrasil's spanning-tree lag; converges in ≤10s
- App-level broadcast — `share_economic_indicator` fanned out to all
  peers via the discovery view (AXL has no native pubsub; we fan out at
  the application layer over MCP)
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

# In a second terminal, run the four Phase 1 gate tests:
./scripts/test-mcp-unicast.sh        # CA → MA query_treasury
./scripts/test-mcp-discovery.sh      # CA's gossip view converges to {MA, TX}
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

## 0G iNFT submission

**Track:** Best Autonomous Agents, Swarms & iNFT Innovations.

**What it is:** 8 deep state-treasurer agents (the federal "deep state":
AK, CA, FL, IL, MA, NY, TX, WA) are minted as ERC-7857 iNFTs on 0G Galileo
testnet. The token is a transferable AI policymaker — its persona, persistent
memory (treasury composition, reserve ratio, received indicators, decision
log) is encrypted, anchored on 0G Storage, and committed to on-chain via
`metadataHash`. As each agent decides and learns, the runtime fires
`INFT7857.updateMetadata(...)` so the chain reflects live thinking.

**Contract addresses (0G Galileo, chain id 16602):**

| Contract     | Address |
|--------------|---------|
| `INFT7857`   | [`0xbae646e0092a74821c54ea36ea342eefb6a26ae1`](https://chainscan-galileo.0g.ai/address/0xbae646e0092a74821c54ea36ea342eefb6a26ae1) |
| `MockOracle` | [`0xdad62bba075bc0193551c91cc5db79e558e5e5db`](https://chainscan-galileo.0g.ai/address/0xdad62bba075bc0193551c91cc5db79e558e5e5db) |

**8 minted iNFTs (token id = state FIPS):**

| Agent | Token | Mint tx |
|-------|-------|---------|
| AK    | #2    | [`0xe06d76dc...`](https://chainscan-galileo.0g.ai/tx/0xe06d76dc76416f9a771ce2a3dc5abdc12f2443a36cd9f7a3a250fb717a57db75) |
| CA    | #6    | [`0xe60ae913...`](https://chainscan-galileo.0g.ai/tx/0xe60ae9139f61caf848a99e947114eaee1024163e9bf19cbbab7e221eabd2f31a) |
| FL    | #12   | [`0xdb9772c9...`](https://chainscan-galileo.0g.ai/tx/0xdb9772c9dd9d79c7dcdb5d8f6be89e3c4cad0587c157d7638b1692e142e05057) |
| IL    | #17   | [`0x25389301...`](https://chainscan-galileo.0g.ai/tx/0x25389301c5dbf19186c7405bb1220d9e39038da431be5f3cfd2c1ecb2c1ab9ae) |
| MA    | #25   | [`0x7cc984d8...`](https://chainscan-galileo.0g.ai/tx/0x7cc984d814562b6c3a702289d3f25a526d86e0dfd5605a98bbf6e456950234e3) |
| NY    | #36   | [`0x56227bb0...`](https://chainscan-galileo.0g.ai/tx/0x56227bb0ee075a8e918cf50184bcb98af2c316e70b9bb206af3d3393bb2a4aa0) |
| TX    | #48   | [`0x0769541d...`](https://chainscan-galileo.0g.ai/tx/0x0769541d18f9ccdd3e9266e0a8dc8e90f85c092d3b599884eed8e91377a0c202) |
| WA    | #53   | [`0xab178604...`](https://chainscan-galileo.0g.ai/tx/0xab17860468bf115a4619f98c2b1bc9eba90b9d424125c93aea0cb6bb34f1ddee) |

**Proof of embedded intelligence (transfer + re-decrypt):** MA token #25 was
transferred to a fresh wallet via the ERC-7857 ceremony in
[`scripts/transfer-inft.ts`](./scripts/transfer-inft.ts) (transfer tx
[`0x18800e59...`](https://chainscan-galileo.0g.ai/tx/0x18800e59ac34ad6ff5579a8555dc34be3b43cd5e79acc416d2608029b2ba30a8)).
The new owner unsealed the rotated symmetric key with their secp256k1
private key, downloaded the encrypted bundle from 0G Storage by root hash,
decrypted it, and verified that `keccak256(plaintext) == metadataHash` on
chain. Receipt: [`.data/inft-transfers/ma.json`](./.data/inft-transfers/ma.json).

**0G features and SDKs used:**

- **0G Storage** via [`@0gfoundation/0g-storage-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-storage-ts-sdk)
  — `Indexer.upload/download` for encrypted agent bundles
  ([packages/og-inft/src/storage.ts](./packages/og-inft/src/storage.ts)).
  Live indexer: `https://indexer-storage-testnet-turbo.0g.ai`.
- **0G Chain (Galileo testnet)** via `viem` — ERC-7857 deploy + per-state
  mint + per-tick `updateMetadata` anchoring.
- **ERC-7857 iNFT** ([contracts/src/INFT7857.sol](./contracts/src/INFT7857.sol))
  — full implementation: `mint`, `updateMetadata`, oracle-verified `transfer`
  with sealed-key rotation, `clone`, `authorizeUsage/revokeUsage`, plus the
  view functions (`encryptedURI`, `metadataHash`, `sealedKey`).
- **AES-256-GCM bundle encryption + ECIES sealed key** (secp256k1 ECDH →
  HKDF-SHA256 → AES-256-GCM wrap, 125-byte wire format) in
  [packages/og-inft/src/crypto.ts](./packages/og-inft/src/crypto.ts).

**Swarm coordination (track requirement):** the 50-agent mesh communicates
**peer-to-peer** over AXL with no central broker. Two channels:

- **MCP** for tool-style operations: `query_treasury`, `share_economic_indicator`,
  `share_topology`, `announce_fed_rate`. Routed via per-host MCP Routers,
  bridged through AXL leaf↔leaf links.
- **A2A** for multi-turn negotiation: `negotiate-bilateral-swap`,
  `propose-bond-purchase`, `coordinate-aid` over `@a2a-js/sdk`. Coalitions
  emerge bottom-up from bilateral A2A rounds.

Full mesh architecture and protocol details:
[docs/TECHNICAL.md](./docs/TECHNICAL.md). Phase 5 iNFT pipeline notes:
[docs/TECHNICAL.md §1593–1605](./docs/TECHNICAL.md).

**Reproduce locally:**

```bash
# 1. Funded wallets in .env.local: WALLET_DEPLOYER_*, WALLET_<ABBR>_* for
#    AK CA FL IL MA NY TX WA. Faucet: https://faucet.0g.ai

# 2. Deploy iNFT + oracle to 0G Galileo
forge build
bun run scripts/deploy-0g.ts

# 3. Mint all 8 deep-state agents (encrypts + uploads + mints + verifies)
bun run scripts/mint-inft.ts

# 4. Re-decrypt any agent from chain alone (proof of embedded intelligence)
bun run scripts/decrypt-inft.ts MA

# 5. Optional: transfer demo (rotates sealed key on chain)
bun run scripts/transfer-inft.ts MA

# 6. Optional: enable runtime memory anchoring on the live mesh
OG_ANCHOR_ENABLED=1 ./scripts/run-local-mesh.sh
```

Outputs: `contracts/deployments/0g-galileo.json` (addresses + per-state mint
records), `.data/inft-manifest.json` (frontend feed), `.data/inft-proofs/`
(decrypt receipts), `.data/inft-transfers/` (transfer ceremonies).

## License

Hackathon submission, no license declared yet. Will be MIT or Apache-2.0
post-hackathon.
