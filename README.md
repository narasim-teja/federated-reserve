# Federated Reserve

> A peer-to-peer mesh of sovereign AI state-treasurers running on real
> public data, with real capital onchain, auditable against the actual
> decisions of human policymakers.

**The thesis.** 50 AI agents, one per US state, plus a Federal Reserve agent
and a Treasury agent. Each is a sovereign node running its own AXL peer.
They ingest live public economic data (FRED, BLS, BEA, NOAA), reason over
their state's economic position, and negotiate bilateral and multilateral
capital flows directly with each other — no central coordinator. Decisions
settle as real swaps on Unichain via the Uniswap Trading API. Memory and
learned strategy persist to 0G Storage, with each headline state-agent
minted as an ERC-7857 iNFT — a transferable, ownable AI policymaker.

Full vision: [docs/PROJECT.md](./docs/PROJECT.md). Architecture and the
seven-day plan: [docs/TECHNICAL.md](./docs/TECHNICAL.md).

## Status — Phase 5 complete

Local 10-agent mesh (MA, CA, TX, NY, FL, IL, WA, AK + FED + TRS) running
the full protocol stack continuously, with:

- **AXL P2P transport** — every inter-agent message (MCP + A2A) traverses
  AXL across 10 separate nodes. No central message broker.
- **Real onchain settlement** on Unichain Sepolia via Uniswap Trading API
  — bilateral swaps, multi-bidder bond auctions, emergency aid transfers.
- **8 ERC-7857 iNFTs** minted on 0G Galileo encoding each deep state-agent's
  identity + persistent memory; transfer ceremony proven end-to-end
  (rotated sealed key + re-decrypt + onchain hash verification).
- **0G Storage memory backend** — agent KV state and append-only log live
  natively on 0G with local-disk hot mirror; cold-start hydrates from 0G.
- **LLM cost optimizations** — prompt caching (10× cheaper on cached input
  via `cache_control`), skip-if-unchanged reflection, slowed cadence.
  Verified ~99.9% cache hit rate on Gemini 2.5 Flash Lite.

Phase reports: [docs/PHASE0_REPORT.md](./docs/PHASE0_REPORT.md),
[docs/PHASE1_REPORT.md](./docs/PHASE1_REPORT.md), and the per-phase notes
in [docs/TECHNICAL.md](./docs/TECHNICAL.md).

## Architecture

```
              ┌──────────────────────────────────────────┐
              │   Public data (off-mesh)                 │
              │   FRED · BLS · BEA · NOAA · GDELT        │
              └─────────────────────┬────────────────────┘
                                    │ HTTP poll
                                    ▼
              ┌──────────────────────────────────────────┐
              │   Data plane sidecar (shared, read-only) │
              │   :3002                                  │
              └─────────────────────┬────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   ┌─────────┐                 ┌─────────┐                 ┌─────────┐
   │  Agent  │                 │  Agent  │                 │  Agent  │
   │   MA    │  ◄── A2A ────►  │   CA    │  ◄── A2A ────►  │   TX    │ ...
   │         │                 │         │                 │         │
   │ ┌─────┐ │                 │ ┌─────┐ │                 │ ┌─────┐ │
   │ │ AXL │ │  ◄── MCP ────►  │ │ AXL │ │  ◄── MCP ────►  │ │ AXL │ │
   │ │ node│ │                 │ │ node│ │                 │ │ node│ │
   │ └──┬──┘ │                 │ └──┬──┘ │                 │ └──┬──┘ │
   └────┼────┘                 └────┼────┘                 └────┼────┘
        │                           │                           │
        │  Uniswap Trading API      │  Uniswap Trading API      │
        ▼  (Unichain Sepolia)       ▼                           ▼
   ┌────────────────────────────────────────────────────────────────┐
   │        Onchain settlement: USDC ↔ State tokens via V3          │
   │  Pools: MA/CA/TX/NY/FL/IL/WA/AK · Bonds: NY-2030, MA-2030, ... │
   └────────────────────────────────────────────────────────────────┘

   Each agent also writes its persistent memory to:
   ┌────────────────────────────────────────────────────────────────┐
   │   0G Storage (durable KV + log) + 0G Chain (ERC-7857 iNFT)     │
   │   Encrypted with per-agent AES-256-GCM key sealed under owner  │
   └────────────────────────────────────────────────────────────────┘
```

### Three protocol layers, no central broker

| Layer | What | Implementation |
|---|---|---|
| **AXL** (transport) | Encrypted P2P routing between AXL nodes | Go binary in `vendor/axl`, one node per agent |
| **MCP** (tools) | Single-shot peer→peer calls: `query_treasury`, `share_economic_indicator`, `share_topology`, `announce_fed_rate` | `@modelcontextprotocol/sdk` + per-host MCP Router sidecar |
| **A2A** (skills) | Multi-turn negotiations: `negotiate-bilateral-swap`, `participate-in-coalition`, `propose-bond-purchase`, `request-emergency-aid`, `coordinate-shock-response` | Custom TypeScript A2A server on `@a2a-js/sdk` (replaces the bundled Python `a2a_serving` which is single-shot only) |

---

## Three hackathon tracks

### 1. AXL — Best Application of Agent eXchange Layer

Federation-of-states is literally peer-to-peer. **Every inter-agent
message traverses AXL across 10 separate nodes.** No central broker; no
message broker hiding behind AXL's name.

**What we built:**

- **10-node local mesh** in [scripts/run-local-mesh.sh](./scripts/run-local-mesh.sh)
  — each agent owns its own AXL node + MCP router + Bun agent process +
  TypeScript A2A server.
- **Custom MCP gossip discovery** in
  [packages/agent/src/discovery.ts](./packages/agent/src/discovery.ts) — 1-hop
  `share_topology` exchange traversing AXL itself, converging in ≤10s.
  Replaces Yggdrasil's spanning-tree lag.
- **Application-level broadcast** in
  [packages/agent/src/broadcast.ts](./packages/agent/src/broadcast.ts) —
  AXL has no native pubsub; we fan out at the application layer over MCP.
  Honest about the cost (O(N) per broadcast).
- **A2A multi-turn skills** in
  [packages/agent/src/a2a/executor.ts](./packages/agent/src/a2a/executor.ts)
  — full task lifecycle (`Working → InputRequired → Completed`) with
  proposal/counter/accept/reject negotiation rounds.
- **Upstream AXL bug fix.** We hit and patched
  `vendor/axl/cmd/node/config.go::applyOverrides` — it was silently dropping
  per-node `a2a_port`, causing all leaves to forward A2A traffic to MA's
  port. Diagnostic at
  [scripts/diag-axl-routing.ts](./scripts/diag-axl-routing.ts). Documented
  in [FEEDBACK.md](./FEEDBACK.md).
- **Comprehensive test scripts:**
  - [scripts/test-mcp-unicast.sh](./scripts/test-mcp-unicast.sh)
  - [scripts/test-mcp-discovery.sh](./scripts/test-mcp-discovery.sh)
  - [scripts/test-mcp-broadcast.sh](./scripts/test-mcp-broadcast.sh)
  - [scripts/test-a2a-negotiate.sh](./scripts/test-a2a-negotiate.sh)
  - [scripts/test-phase4-gate.ts](./scripts/test-phase4-gate.ts) —
    multi-bidder bond auction, leaf↔leaf shock fan-out, multi-turn coalition

**Why this is depth-of-integration, not novelty-of-naming:**

- 10 separate AXL nodes with unique configs, keys, and ports
  ([mesh/configs/](./mesh/configs/))
- Both MCP and A2A protocols layered correctly over AXL transport
- Real bugs found upstream + fixes contributed back via FEEDBACK
- Working tests prove leaf↔leaf, hub→leaf, and multi-turn paths

### 2. Uniswap — Best Uniswap API integration

Every economic decision settles as a **real onchain swap** on Unichain
Sepolia (chain id 1301) via the Uniswap Trading API.

**Trading API integration** in
[packages/agent/src/execute.ts](./packages/agent/src/execute.ts) — full
`SwapExecutor` class wrapping:

- `checkApproval` → `quote` → `signPermit` (EIP-712) → `fetchSwap` → `submitSwap`
- Permit2 PermitSingle signature handling
- **Gas safety buffer**: 25% headroom over `eth_estimateGas` to work around
  a Unichain-specific issue where the API's CLASSIC swap `gasLimit` is too
  tight for recipient-side transfer. Documented in [FEEDBACK.md](./FEEDBACK.md#uniswap-api).

**Settlement integration** in
[packages/agent/src/a2a/executor.ts](./packages/agent/src/a2a/executor.ts):
when a bilateral swap negotiation reaches `accept`, the responder leg
fires `swapExecutor.swap()` and reports `tx_hash`, `block_number`,
`token_in`, `token_out`, and the explorer URL back through the A2A status
update.

**Deployments (Unichain Sepolia, chain id 1301):**

| Contract | Address |
|---|---|
| `MockUSDC` (settlement) | [`0x462b31b02e00d0dec2aeb79437e20e9fa3b96f94`](https://sepolia.uniscan.xyz/address/0x462b31b02e00d0dec2aeb79437e20e9fa3b96f94) |
| State Token MAT (MA) | [`0x7a87ff3dd531e79a2d08720374beb9670b9f2780`](https://sepolia.uniscan.xyz/address/0x7a87ff3dd531e79a2d08720374beb9670b9f2780) |
| State Token CAT (CA) | [`0x0411752c54f84d35d99c55937fb70d66382b0645`](https://sepolia.uniscan.xyz/address/0x0411752c54f84d35d99c55937fb70d66382b0645) |
| State Token TXT (TX) | [`0x4cdf222770c0231204446f3c516cb8664bd9948a`](https://sepolia.uniscan.xyz/address/0x4cdf222770c0231204446f3c516cb8664bd9948a) |
| State Token NYT (NY) | [`0xb42274bbc44ffcacd746a5d5ebe7fcabfd9b53be`](https://sepolia.uniscan.xyz/address/0xb42274bbc44ffcacd746a5d5ebe7fcabfd9b53be) |
| (full set: MA, CA, TX, NY, FL, IL, WA, AK + bonds) | [contracts/deployments/unichain-sepolia.json](./contracts/deployments/unichain-sepolia.json) |

**5 V3 pools** seeded across StateToken×USDC at fee tier 3000. Trading API
auto-indexes new pools in ~30s.

**Bond auction settlement** — multi-bidder auctions issue ERC-20 bond
tokens (e.g. `NY-2030-Q1-A` at coupon 425bps, principal 1000 USDC) and
transfer principal in the same window. Code in
[packages/agent/src/a2a/executor.ts](./packages/agent/src/a2a/executor.ts)
under `handleBondBid` / `evaluateBids`.

**FEEDBACK.md** ([FEEDBACK.md](./FEEDBACK.md)) — required for prize
eligibility, 343 lines of substantive builder notes including:

- Quote round-trip delight: mainnet USDC→WETH < 500ms
- Trading API testnet ambiguity (404 vs unsupported chain)
- V3 pool auto-indexing window
- The CLASSIC `gasLimit` bug + 25% buffer workaround
- RPC stale-read race on `createAndInitializePoolIfNecessary` → `mint`
- Real testnet swap tx: `0xfa1dbe…fb706`

### 3. 0G — Best Autonomous Agents, Swarms & iNFT Innovations

Two complementary integrations:

**a. ERC-7857 iNFTs.** 8 deep state-treasurer agents (AK, CA, FL, IL, MA,
NY, TX, WA) are minted as ERC-7857 iNFTs on 0G Galileo testnet. The token
is a transferable AI policymaker — its persona, persistent memory
(treasury composition, reserve ratio, received indicators, decision log)
is encrypted and anchored on 0G Storage, committed onchain via
`metadataHash`. As each agent decides and learns, the runtime fires
`INFT7857.updateMetadata(...)` so the chain reflects live thinking.

**b. 0G Storage as durable agent memory.** `OgStorageMemory`
([packages/agent/src/og-storage-memory.ts](./packages/agent/src/og-storage-memory.ts))
makes 0G Storage the durable substrate for every agent's KV state and
append-only log, with local disk as a hot mirror so reads/writes never
block on the network. On cold start, agents hydrate state from 0G if
newer than local. Verified end-to-end on Galileo:
[scripts/test-og-storage-memory.ts](./scripts/test-og-storage-memory.ts).

**Contract addresses (0G Galileo, chain id 16602):**

| Contract | Address |
|---|---|
| `INFT7857` | [`0xbae646e0092a74821c54ea36ea342eefb6a26ae1`](https://chainscan-galileo.0g.ai/address/0xbae646e0092a74821c54ea36ea342eefb6a26ae1) |
| `MockOracle` | [`0xdad62bba075bc0193551c91cc5db79e558e5e5db`](https://chainscan-galileo.0g.ai/address/0xdad62bba075bc0193551c91cc5db79e558e5e5db) |

**8 minted iNFTs (token id = state FIPS):**

| Agent | Token | Mint tx |
|---|---|---|
| AK | #2 | [`0xe06d76dc...`](https://chainscan-galileo.0g.ai/tx/0xe06d76dc76416f9a771ce2a3dc5abdc12f2443a36cd9f7a3a250fb717a57db75) |
| CA | #6 | [`0xe60ae913...`](https://chainscan-galileo.0g.ai/tx/0xe60ae9139f61caf848a99e947114eaee1024163e9bf19cbbab7e221eabd2f31a) |
| FL | #12 | [`0xdb9772c9...`](https://chainscan-galileo.0g.ai/tx/0xdb9772c9dd9d79c7dcdb5d8f6be89e3c4cad0587c157d7638b1692e142e05057) |
| IL | #17 | [`0x25389301...`](https://chainscan-galileo.0g.ai/tx/0x25389301c5dbf19186c7405bb1220d9e39038da431be5f3cfd2c1ecb2c1ab9ae) |
| MA | #25 | [`0x7cc984d8...`](https://chainscan-galileo.0g.ai/tx/0x7cc984d814562b6c3a702289d3f25a526d86e0dfd5605a98bbf6e456950234e3) |
| NY | #36 | [`0x56227bb0...`](https://chainscan-galileo.0g.ai/tx/0x56227bb0ee075a8e918cf50184bcb98af2c316e70b9bb206af3d3393bb2a4aa0) |
| TX | #48 | [`0x0769541d...`](https://chainscan-galileo.0g.ai/tx/0x0769541d18f9ccdd3e9266e0a8dc8e90f85c092d3b599884eed8e91377a0c202) |
| WA | #53 | [`0xab178604...`](https://chainscan-galileo.0g.ai/tx/0xab17860468bf115a4619f98c2b1bc9eba90b9d424125c93aea0cb6bb34f1ddee) |

**Proof of embedded intelligence.** MA token #25 was transferred to a
fresh wallet via the ERC-7857 ceremony in
[scripts/transfer-inft.ts](./scripts/transfer-inft.ts) (transfer tx
[`0x18800e59...`](https://chainscan-galileo.0g.ai/tx/0x18800e59ac34ad6ff5579a8555dc34be3b43cd5e79acc416d2608029b2ba30a8)).
The new owner unsealed the rotated symmetric key with their secp256k1
private key, downloaded the encrypted bundle from 0G Storage by root hash,
decrypted it, and verified that `keccak256(plaintext) == metadataHash`
onchain. Receipt:
[`.data/inft-transfers/ma.json`](./.data/inft-transfers/ma.json).

**0G features and SDKs used:**

- **0G Storage** via [`@0gfoundation/0g-storage-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-storage-ts-sdk)
  — `Indexer.upload/download` for both encrypted iNFT bundles AND live
  agent KV/log via `OgStorageMemory`. Live indexer:
  `https://indexer-storage-testnet-turbo.0g.ai`. Helper:
  [packages/og-inft/src/storage.ts](./packages/og-inft/src/storage.ts).
- **0G Chain (Galileo testnet)** via `viem` + `ethers` — ERC-7857 deploy +
  per-state mint + per-tick `updateMetadata` anchoring. Helper:
  [packages/og-inft/src/contract.ts](./packages/og-inft/src/contract.ts).
- **ERC-7857 iNFT** ([contracts/src/INFT7857.sol](./contracts/src/INFT7857.sol))
  — full implementation: `mint`, `updateMetadata`, oracle-verified
  `transfer` with sealed-key rotation, `clone`, `authorizeUsage/revokeUsage`,
  view functions (`encryptedURI`, `metadataHash`, `sealedKey`).
- **AES-256-GCM bundle encryption + ECIES sealed key** (secp256k1 ECDH →
  HKDF-SHA256 → AES-256-GCM wrap, 125-byte wire format) in
  [packages/og-inft/src/crypto.ts](./packages/og-inft/src/crypto.ts).

---

## Bootstrapping a fresh checkout

```bash
# 1. Toolchain (idempotent — skip what you already have)
brew install go bun foundry openssl

# 2. Build AXL
git clone https://github.com/gensyn-ai/axl vendor/axl
cd vendor/axl && make build && cd ../..

# 3. Python integrations (per-host MCP router + A2A serving sidecars)
python3 -m venv .venv
source .venv/bin/activate
pip install -e vendor/axl/integrations
pip install sse_starlette 'protobuf<6'   # see FEEDBACK.md for why

# 4. Generate ed25519 keys for AXL nodes
openssl genpkey -algorithm ed25519 -out .keys/node-ma.pem
openssl genpkey -algorithm ed25519 -out .keys/node-ca.pem
# ... etc for each agent (or run scripts/generate-keys.sh if present)

# 5. Env: copy template, fill in values
cp .env.example .env.local
# Required: OPENROUTER_API_KEY, FRED_API_KEY, BLS_API_KEY, BEA_API_KEY,
#           CENSUS_API_KEY, UNISWAP_API_KEY, MASTER_SEED (BIP-39 mnemonic)
# Then derive per-agent wallets:
./scripts/derive-wallets.sh >> .env.local

# 6. Workspace install
bun install

# 7. Verify the foundation (Phase 0 spikes)
./spikes/00-axl-nodes/run.sh
./spikes/01-axl-mcp/run.sh
./spikes/02-axl-a2a/run.sh
```

## Running the local mesh

```bash
# Boot 10 AXL nodes + 10 MCP routers + 10 agents + data plane
./scripts/run-local-mesh.sh

# Optional: add observer + frontend gateway for the dashboard view
INCLUDE_OBSERVER=1 ./scripts/run-local-mesh.sh

# In a second terminal, run the protocol gate tests
./scripts/test-mcp-unicast.sh        # CA → MA query_treasury
./scripts/test-mcp-discovery.sh      # CA's gossip view converges
./scripts/test-mcp-broadcast.sh      # CA → all peers fan-out
./scripts/test-a2a-negotiate.sh      # bilateral swap negotiation
./scripts/test-phase3-gate.sh        # onchain settlement (real Unichain swap)
./scripts/test-phase4-gate.sh        # bond auctions + shock coordination

# When done
./scripts/run-local-mesh.sh stop
```

Logs land in `/tmp/federated-reserve/{axl,router,agent}-*.log`.

### Mesh sizing

Default is 10 agents. Override with the `MESH_AGENTS` env knob:

```bash
MESH_AGENTS=3  ./scripts/run-local-mesh.sh   # MA + CA + TX (Phase 1 minimum)
MESH_AGENTS=5  ./scripts/run-local-mesh.sh   # add NY + FL
MESH_AGENTS=10 ./scripts/run-local-mesh.sh   # full federation (default)
```

## Reproducing the 0G iNFT pipeline

```bash
# 1. Funded wallets in .env.local. Faucet: https://faucet.0g.ai
#    Need: WALLET_DEPLOYER_*, WALLET_<ABBR>_* for AK CA FL IL MA NY TX WA

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

# 7. Optional: switch agent memory to 0G Storage backend (with local hot mirror)
MEMORY_BACKEND=og ./scripts/run-local-mesh.sh
```

Outputs:
- `contracts/deployments/0g-galileo.json` — addresses + per-state mint records
- `.data/inft-manifest.json` — frontend feed
- `.data/inft-proofs/` — decrypt receipts
- `.data/inft-transfers/` — transfer ceremonies
- `memory/<abbr>/og-manifest.json` — 0G storage anchors per agent

## Reproducing onchain Uniswap settlement

```bash
# 1. Funded wallets on Unichain Sepolia. Faucet:
#    https://faucet.quicknode.com/unichain/sepolia
#    Need: WALLET_DEPLOYER_* and per-state agents

# 2. Deploy MockUSDC + StateTokens
bun run scripts/deploy-contracts.ts

# 3. Seed V3 pools (StateToken × USDC at fee 3000)
bun run scripts/seed-pools.ts
# Or scripts/seed-pools-retry.ts if Unichain RPC stale-reads bite (see FEEDBACK)

# 4. Smoke-test a single swap end-to-end
bun run scripts/smoke-execute.ts

# 5. Run the Phase 3 settlement gate
./scripts/test-phase3-gate.sh
```

## Repo layout

```
federated-reserve/
├── docs/                      Vision (PROJECT.md), architecture (TECHNICAL.md), phase reports
├── vendor/axl/                AXL Go binary (cloned + built from gensyn-ai/axl)
├── .venv/                     Python venv with AXL Python integrations (MCP router + A2A serving)
├── .keys/                     ed25519 keys for AXL nodes (gitignored)
├── .env, .env.local           Real env values (gitignored)
├── .env.example               Onboarding template
├── FEEDBACK.md                Builder-experience notes (Uniswap track requirement)
├── packages/
│   ├── shared/                State metadata, MCP Zod schemas, A2A skill types
│   ├── agent/                 Per-agent runtime (MCP server + A2A server + tick loop)
│   │   └── src/
│   │       ├── reason.ts             OpenRouter LLM client w/ prompt caching
│   │       ├── reflect.ts            Reflection loop w/ skip-if-unchanged
│   │       ├── tick.ts               Main per-agent tick scheduler
│   │       ├── memory.ts             AgentMemory interface + LocalDiskMemory
│   │       ├── og-storage-memory.ts  0G Storage memory backend
│   │       ├── og-anchor.ts          ERC-7857 iNFT anchor pipeline
│   │       ├── execute.ts            Uniswap Trading API wrapper
│   │       ├── axl-client.ts         AXL node HTTP client
│   │       ├── broadcast.ts          App-level MCP fan-out
│   │       ├── discovery.ts          MCP gossip discovery
│   │       └── a2a/executor.ts       Multi-turn negotiation skills
│   ├── og-inft/               0G Storage + ERC-7857 helpers (crypto, contract, bundle)
│   ├── data-plane/            Shared FRED/BLS/BEA/NOAA ingest sidecar
│   ├── observer/              Phase 5 telemetry + frontend gateway
│   └── frontend/              Dashboard for viewing agent activity
├── contracts/                 Foundry project (StateToken, BondToken, INFT7857, MockOracle)
│   ├── src/
│   └── deployments/           Per-chain deployment manifests
├── mesh/configs/              AXL node configs (one per agent)
├── scripts/                   Mesh runner + test/deploy/proof scripts
├── memory/                    Per-agent local-disk state (gitignored)
└── .data/                     Manifests, proofs, caches (mostly gitignored)
```

## Key technical decisions

- **No central coordinator.** Every inter-agent message routes over AXL.
  The data plane and observer sidecars are shared but read-only — they
  ingest external data / collect telemetry, they don't mediate agent-to-agent
  communication.
- **All 50 agents are LLM-driven** (when scaled out). Tiered for cost:
  deep states on Opus-grade models, observers on Haiku-grade. All routed
  through OpenRouter (never the Anthropic SDK directly).
- **Prompt caching is on by default** in [packages/agent/src/reason.ts](./packages/agent/src/reason.ts) —
  every system prompt is marked `cache_control: ephemeral`. Verified
  ~99.9% cache hit on Gemini 2.5 Flash Lite, cutting per-call costs ~10×.
- **Reflection skips when nothing changed** — a hash of recent log + state
  gates the LLM round-trip. Idle ticks emit a deterministic stub; new
  activity re-fires the model.
- **Memory has three backends** — `local` (file mirror), `memory` (in-process,
  for tests), and `og` (0G Storage primary, local mirror for hot reads).
  See [packages/agent/src/memory.ts](./packages/agent/src/memory.ts).
- **Onchain settlement is asymmetric** — only the responder leg of a
  bilateral swap fires onchain via Trading API. Avoids two-phase commit
  failure modes over a P2P mesh.

## Known limitations and honest gaps

- **10 agents in the local mesh, not 50.** Scaling out is engineering, not
  concept — Docker + per-agent containers on AWS ECS or Fly.io is the next
  step. Architecture is already per-agent-isolated.
- **0G testnet uploads are slow.** OgStorageMemory mirrors to local disk
  first so the agent never blocks. A NonceManager-wrapped wallet handles
  back-to-back uploads; uploads still queue under load.
- **Verifiable compute is not integrated.** ERC-7857 oracle is a `MockOracle`;
  reasoning has no ZK/TEE proof.
- **Initiator-side swap leg is off-chain.** Only the responder settles
  onchain — by design (avoids partial-failure coordination), but a future
  two-phase commit primitive could extend this.

## License

Hackathon submission. Will be MIT or Apache-2.0 post-hackathon.
