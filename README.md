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

## Quick links

| What | Where |
|---|---|
| **Live demo** | [fedreserve.live](https://fedreserve.live) |
| **iNFT contract on 0G Galileo** | [`0xbae646e0092a74821c54ea36ea342eefb6a26ae1`](https://chainscan-galileo.0g.ai/address/0xbae646e0092a74821c54ea36ea342eefb6a26ae1) |
| **Embedded-intelligence proof** (transfer ceremony) | [docs/proof/inft-transfer-ma.json](./docs/proof/inft-transfer-ma.json) → [verification tx](https://chainscan-galileo.0g.ai/tx/0x18800e59ac34ad6ff5579a8555dc34be3b43cd5e79acc416d2608029b2ba30a8) |
| **All 8 minted iNFTs** | see [iNFT registry](#minted-inft-registry-token-id--state-fips) below |
| **All deployed contracts** | see [Contract addresses](#contract-addresses) below |

## Architecture

```
            ┌─────────────────────────────────────────────────────┐
            │      PUBLIC ECONOMIC DATA  (read-only, off-mesh)    │
            │     FRED · BLS · BEA · Census · NOAA · GDELT        │
            └────────────────────────┬────────────────────────────┘
                                     │
                       ┌─────────────┴─────────────┐
                       │  Read-only data-plane     │  :3002
                       │  sidecar (shared)         │
                       └─────────────┬─────────────┘
                                     │
   ┌─────────────────────────────────┼─────────────────────────────────┐
   ▼                                 ▼                                 ▼
┌─────────┐                     ┌─────────┐                       ┌─────────┐
│ Agent MA│        ◄ AXL ►      │ Agent CA│        ◄ AXL ►        │ Agent TX│  ...×50
│   LLM   │                     │   LLM   │                       │   LLM   │
└────┬────┘                     └────┬────┘                       └────┬────┘
     │                               │                                 │
     └───────────────────────────────┴─────────────────────────────────┘
                                     │
              Two protocols layered on AXL transport (no central broker)
            ─────────────────────────────────────────────────────────────
              MCP  (single-shot)  : query_treasury · share_indicator
                                    share_topology  ← 1-hop gossip
              A2A  (multi-turn)   : negotiate-bilateral-swap
                                    bond-auction · participate-in-coalition
                                    request-emergency-aid
                                    coordinate-shock-response
                                     │
            ┌────────────────────────┴────────────────────────┐
            ▼                                                 ▼
   ┌──────────────────────┐                         ┌──────────────────────┐
   │   SETTLEMENT         │                         │   PERSISTENT MEMORY  │
   │   Unichain Sepolia   │                         │   0G Galileo         │
   │                      │                         │                      │
   │   Uniswap Trading    │                         │   ERC-7857 iNFT      │
   │   API → real swaps   │                         │   + 0G Storage       │
   │   USDC ↔ state tokens│                         │   (AES-256-GCM,      │
   │   + bond auctions    │                         │    sealed under owner│
   │   (coupon+maturity)  │                         │    secp256k1 pubkey) │
   └──────────────────────┘                         └──────────────────────┘
```

### Three protocol layers, no central broker

| Layer | What | Implementation |
|---|---|---|
| **AXL** (transport) | Encrypted P2P routing between AXL nodes | Go binary in `vendor/axl`, one node per agent |
| **MCP** (tools) | Single-shot peer→peer calls: `query_treasury`, `share_economic_indicator`, `share_topology`, `announce_fed_rate` | `@modelcontextprotocol/sdk` + per-host MCP Router sidecar |
| **A2A** (skills) | Multi-turn negotiations: `negotiate-bilateral-swap`, `participate-in-coalition`, `propose-bond-purchase`, `request-emergency-aid`, `coordinate-shock-response` | Custom TypeScript A2A server on `@a2a-js/sdk` (replaces the bundled Python `a2a_serving` which is single-shot only) |

### How agents communicate and coordinate

**Communication.** No agent has a privileged route to any other agent.
Every inter-agent message traverses AXL, an encrypted peer-to-peer
network where each application talks to localhost and AXL handles
routing, encryption, and discovery across the mesh. We run **ten
separate AXL nodes** in the local mesh, one per agent, each with its
own ed25519 keypair and ports. On top of AXL transport we layer two
protocols:

- **MCP** for single-shot calls. An agent that wants to ask a peer "what
  is your current treasury composition" or "tell me your view of the
  topology" issues an MCP `tools/call` over AXL. We added a 1-hop
  `share_topology` gossip layer because AXL's native topology view is
  eventually-consistent; after one or two rounds the mesh converges.
- **A2A** for multi-turn skills with full task lifecycle (`Working →
  InputRequired → Completed`). This is where the actual coordination
  happens. Each skill is a multi-message dance, not a single call.

**Coordination.** Five A2A skills cover the coordination patterns:

| Skill | Pattern | Who's involved |
|---|---|---|
| `negotiate-bilateral-swap` | Proposal → counter → accept/reject; up to 3 rounds | 2 agents |
| `bond-auction` | Issuer announces, peers bid, evaluator awards in-window | 1 issuer + N bidders |
| `participate-in-coalition` | Initiator invites, peers accept/decline/counter terms, revised invite, final response | 1 initiator + N invitees |
| `request-emergency-aid` | Stressed state requests, peers offer or decline | 1 requester + N responders |
| `coordinate-shock-response` | Shock signal fans out, peers commit contributions | 1 broadcaster + N responders |

The shock-response loop is the most P2P-flavored: a NOAA event triggers
a state to broadcast a `coordinate-shock-response` signal across the
mesh, peers that have affinity (geographic, economic) commit
contributions, and the response materializes without any central
coordinator deciding who pays in. The bond auction is similar but
financial: an issuer mints debt, multiple bidders compete in the same
window, the issuer evaluates against an algorithmic credit-rating
floor, and the winner gets the ERC-20 bond token.

**Shared state.** Every agent's persona, treasury, and decision log
persist to **0G Storage** as the durable substrate (with a local hot
mirror for read latency). Headline agents are anchored on chain via
their ERC-7857 iNFT, so the shared on-chain view is always
keccak-verifiable against the off-chain bundle. See [Proof of embedded
intelligence](#proof-of-embedded-intelligence) below.

**Where to verify.** The live mesh runs at
[fedreserve.live](https://fedreserve.live) — open the dashboard, watch
the message feed scroll in real time, and click into any negotiation,
bond auction, or shock fan-out as it happens. Locally,
[scripts/test-phase4-gate.ts](./scripts/test-phase4-gate.ts) exercises
the same flows end-to-end across the 10-node AXL mesh: multi-bidder
bond auction, leaf↔leaf shock fan-out, multi-turn coalition.

---

## Three Layers:

### 1. AXL 

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

### 2. Uniswap

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

<a id="contract-addresses"></a>
**Deployments (Unichain Sepolia, chain id 1301):**

| Contract | Address |
|---|---|
| `MockUSDC` (settlement) | [`0x462b31b02e00d0dec2aeb79437e20e9fa3b96f94`](https://sepolia.uniscan.xyz/address/0x462b31b02e00d0dec2aeb79437e20e9fa3b96f94) |
| State Token MAT (MA) | [`0x7a87ff3dd531e79a2d08720374beb9670b9f2780`](https://sepolia.uniscan.xyz/address/0x7a87ff3dd531e79a2d08720374beb9670b9f2780) |
| State Token CAT (CA) | [`0x0411752c54f84d35d99c55937fb70d66382b0645`](https://sepolia.uniscan.xyz/address/0x0411752c54f84d35d99c55937fb70d66382b0645) |
| State Token TXT (TX) | [`0x4cdf222770c0231204446f3c516cb8664bd9948a`](https://sepolia.uniscan.xyz/address/0x4cdf222770c0231204446f3c516cb8664bd9948a) |
| State Token NYT (NY) | [`0xb42274bbc44ffcacd746a5d5ebe7fcabfd9b53be`](https://sepolia.uniscan.xyz/address/0xb42274bbc44ffcacd746a5d5ebe7fcabfd9b53be) |
| State Token FLT (FL) | [`0x03d93986991d5ee4c43528f02bffad1a54172c0e`](https://sepolia.uniscan.xyz/address/0x03d93986991d5ee4c43528f02bffad1a54172c0e) |
| State Token ILT (IL) | [`0x07655e6201a712cb92462c996334ead03540be7d`](https://sepolia.uniscan.xyz/address/0x07655e6201a712cb92462c996334ead03540be7d) |
| State Token WAT (WA) | [`0xee38b79b622a752fd4fa8ab7b2463d0ebb35cf71`](https://sepolia.uniscan.xyz/address/0xee38b79b622a752fd4fa8ab7b2463d0ebb35cf71) |
| State Token AKT (AK) | [`0xa0153eae2d853e7cdaedcb4ce7849ada307aeef5`](https://sepolia.uniscan.xyz/address/0xa0153eae2d853e7cdaedcb4ce7849ada307aeef5) |
| Full manifest (incl. bond tokens) | [contracts/deployments/unichain-sepolia.json](./contracts/deployments/unichain-sepolia.json) |

**5 V3 pools** seeded across StateToken×USDC at fee tier 3000. Trading API
auto-indexes new pools in ~30s.

**Bond auction settlement** — multi-bidder auctions issue ERC-20 bond
tokens (e.g. `NY-2030-Q1-A` at coupon 425bps, principal 1000 USDC) and
transfer principal in the same window. Code in
[packages/agent/src/a2a/executor.ts](./packages/agent/src/a2a/executor.ts)
under `handleBondBid` / `evaluateBids`.

### 3. 0G

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

<a id="minted-inft-registry-token-id--state-fips"></a>
**8 minted iNFTs (token id = state FIPS).** Each row is one minted ERC-7857
iNFT on 0G Galileo. Token id equals the state's FIPS code so the on-chain
identity is human-readable.

| Agent | Token | Mint tx | Owner |
|---|---|---|---|
| AK | #2  | [`0xe06d76dc...`](https://chainscan-galileo.0g.ai/tx/0xe06d76dc76416f9a771ce2a3dc5abdc12f2443a36cd9f7a3a250fb717a57db75) | `0xf791...a889` |
| CA | #6  | [`0xe60ae913...`](https://chainscan-galileo.0g.ai/tx/0xe60ae9139f61caf848a99e947114eaee1024163e9bf19cbbab7e221eabd2f31a) | `0xd842...6249` |
| FL | #12 | [`0xdb9772c9...`](https://chainscan-galileo.0g.ai/tx/0xdb9772c9dd9d79c7dcdb5d8f6be89e3c4cad0587c157d7638b1692e142e05057) | `0x210b...0aa2` |
| IL | #17 | [`0x25389301...`](https://chainscan-galileo.0g.ai/tx/0x25389301c5dbf19186c7405bb1220d9e39038da431be5f3cfd2c1ecb2c1ab9ae) | `0xFF09...6088` |
| MA | #25 | [`0x7cc984d8...`](https://chainscan-galileo.0g.ai/tx/0x7cc984d814562b6c3a702289d3f25a526d86e0dfd5605a98bbf6e456950234e3) | `0x1983...aBf6` (post-transfer) |
| NY | #36 | [`0x56227bb0...`](https://chainscan-galileo.0g.ai/tx/0x56227bb0ee075a8e918cf50184bcb98af2c316e70b9bb206af3d3393bb2a4aa0) | `0x3575...700C` |
| TX | #48 | [`0x0769541d...`](https://chainscan-galileo.0g.ai/tx/0x0769541d18f9ccdd3e9266e0a8dc8e90f85c092d3b599884eed8e91377a0c202) | `0x6966...cE8c` |
| WA | #53 | [`0xab178604...`](https://chainscan-galileo.0g.ai/tx/0xab17860468bf115a4619f98c2b1bc9eba90b9d424125c93aea0cb6bb34f1ddee) | `0x1cb0...2f52` |

All eight live under the same iNFT contract:
[`0xbae646e0092a74821c54ea36ea342eefb6a26ae1`](https://chainscan-galileo.0g.ai/address/0xbae646e0092a74821c54ea36ea342eefb6a26ae1).

<a id="proof-of-embedded-intelligence"></a>
### Proof of embedded intelligence

The intelligence and memory are **actually** embedded in the iNFT, not
just referenced as metadata. To show this, we ran a real ERC-7857
transfer ceremony where the new owner re-derives the agent's full state
from chain alone.

**MA token #25** was transferred from the original deployer wallet to a
fresh wallet via the ERC-7857 ceremony in
[scripts/transfer-inft.ts](./scripts/transfer-inft.ts).

| | Before transfer | After transfer |
|---|---|---|
| Owner | `0x2926...AC88` | `0x1983...aBf6` |
| Sealed key | `0x04590ce9...58ef` | `0x04847315...45f6fe` |
| Encrypted bundle URI | `0g://7c06eeae...d9cfdc` (unchanged) | `0g://7c06eeae...d9cfdc` (unchanged) |
| Metadata hash | `0x60bdb6ee...0d57f` (unchanged) | `0x60bdb6ee...0d57f` (unchanged) |

Transfer tx:
[`0x18800e59ac34ad6ff5579a8555dc34be3b43cd5e79acc416d2608029b2ba30a8`](https://chainscan-galileo.0g.ai/tx/0x18800e59ac34ad6ff5579a8555dc34be3b43cd5e79acc416d2608029b2ba30a8).

After the transfer, the new owner:

1. Read the rotated `sealedKey` directly off chain.
2. Decrypted it with their secp256k1 private key (ECIES → AES-256-GCM key recovery).
3. Read `encryptedURI` off chain → downloaded the encrypted bundle from 0G Storage by root hash `0x7c06eeae...d9cfdc`.
4. AES-256-GCM decrypted the bundle to plaintext.
5. Computed `keccak256(plaintext)` and verified it equals `metadataHash` on chain (`0x60bdb6ee...0d57f`).
6. Decoded the plaintext to recover the live MA agent: persona, treasury composition, reserve ratio, received economic indicators, and the most recent 16 reflection / decision log entries (tickCount = 512).

The intelligence and memory **travelled with the token**. Without the
token, no one (not even the original minter) can decrypt the bundle. With
the token, the new owner gets a fully-functioning shadow MA treasurer
with its complete decision history intact.

Sanitized receipt (private key redacted, all on-chain artifacts present):
[`docs/proof/inft-transfer-ma.json`](./docs/proof/inft-transfer-ma.json).

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
├── docs/                      Vision (PROJECT.md)
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
