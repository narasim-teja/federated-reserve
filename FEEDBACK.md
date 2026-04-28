# FEEDBACK.md

> Builder-experience notes from integrating with the hackathon track APIs.
> Required deliverable for the Uniswap track. Maintained continuously starting
> Phase 0.

Format: each entry is timestamped, scoped (AXL / Uniswap / 0G / data-source),
and labels the friction or delight: `friction:` / `gotcha:` / `delight:` /
`docs-gap:` / `bug:`.

---

## 2026-04-27 — Phase 0 setup

### AXL

- **`docs-gap:` (Gensyn AXL get-started)** — The local two-node test recipe at
  https://docs.gensyn.ai/tech/agent-exchange-layer/get-started shows
  `node-config-2.json` with only `api_port` and `tcp_port` overridden. It
  doesn't show the `Listen`/`Peers` settings needed for the two nodes to
  actually peer with each other on the same machine without an external
  bootstrap. Following the recipe verbatim leaves both nodes with empty peer
  lists. Worked once we explicitly added `"Listen": ["tls://127.0.0.1:9001"]`
  to node A and `"Peers": ["tls://127.0.0.1:9001"]` to node B.

- **`gotcha:` (macOS openssl)** — Docs warn LibreSSL lacks ed25519. On modern
  macOS with Homebrew, system `openssl` IS Homebrew's OpenSSL 3.x, so the
  warning doesn't apply. Worth clarifying in docs that
  `openssl version | grep OpenSSL` is the actual check, not just "macOS".

- **`gotcha:` (Go 1.26 build conflict)** — `gvisor.dev/gvisor` clashes with
  Go 1.26. Makefile pins `GOTOOLCHAIN=go1.25.5` and Go 1.21+ auto-fetches the
  pinned toolchain, so brew's `go@1.26` works fine — but only if `go env
  GOTOOLCHAIN` returns `auto` (the default). Worth documenting that
  `GOTOOLCHAIN=local` would break this.

- **`docs-gap:` (Python integrations are mandatory for MCP/A2A)** — README
  frames MCP and A2A as native AXL features, but actually the AXL Go binary
  only forwards inbound requests to external services on `router_addr` and
  `a2a_addr`. The reference router and A2A server are Python (in
  `integrations/`). Anyone building TS-only stacks will need to reimplement
  these — which is fine, but the integrations docs page should call this
  out up front rather than buried in the config table.

- **`docs-gap:` (A2A server is MCP-derived)** — The bundled
  `a2a_serving.a2a_server` auto-derives A2A skills from registered MCP
  services. This means it can't host first-class A2A skills with rich task
  lifecycles (Working → InputRequired → Completed). Anyone wanting that needs
  to write a custom A2A server.

- **`bug:` (tcp_port docs guidance is wrong)** — Both the public docs
  (https://docs.gensyn.ai/tech/agent-exchange-layer/get-started) and the
  troubleshooting page tell you to "use different `tcp_port` values on the
  same machine." The two-node example config has `tcp_port: 7001` for node B.
  This **breaks `/send`** because `api/send.go` `dialPeerConnection` uses the
  *local node's* `TCPPort` as the destination port (the dialer assumes the
  whole network uses one port). gVisor TCP is virtual per-process so both
  nodes can safely use `tcp_port: 7000` on the same host. Fix produced
  immediate working `/send` round-trip in our spike-00. Suggested doc fix:
  delete the differing `tcp_port` from `node-config-2.json` examples and
  clarify in the troubleshooting page that the same port should be used.

- **`bug:` (Python A2A server missing transitive dep)** — Fresh
  `pip install -e vendor/axl/integrations` installs the `a2a` library but
  doesn't pull in `sse_starlette`, which `a2a/compat/v0_3/jsonrpc_adapter.py`
  imports unconditionally. `python -m a2a_serving.a2a_server` fails on import
  with `ModuleNotFoundError: No module named 'sse_starlette'`. Workaround:
  `pip install sse_starlette` (also installs starlette). Suggested fix: pin
  these in the `a2a` package's pyproject extras or in
  `integrations/pyproject.toml`.

- **`delight:` (`webStandardStreamableHttp` transport)** — The MCP SDK ships
  a `WebStandardStreamableHTTPServerTransport` (separate from the Node-only
  `StreamableHTTPServerTransport`) whose `handleRequest(req: Request)`
  returns a `Response`. This drops directly into `Bun.serve({ fetch })`
  with zero Node-http shimming. Combined with the router's simple
  `POST /register` API, total integration code is about 80 lines.

- **`gotcha:` (MCP SDK stateless transport is single-use)** — When you
  configure `WebStandardStreamableHTTPServerTransport` with
  `sessionIdGenerator: undefined`, every transport instance can handle
  exactly one request before throwing
  `"Stateless transport cannot be reused across requests"` on the second
  call. The SDK enforces this in `webStandardStreamableHttp.js:140`. For
  AXL-fronted services (where the router/bridge has no concept of MCP
  sessions), you must instantiate a fresh `McpServer + transport` per
  HTTP request. This is fine for our use case but costs a small allocation
  per call. Worth documenting in MCP SDK docs.

- **`gotcha:` (MCP `tools/call` wraps text content)** — Tool results return
  `{ content: [{ type: 'text', text: '<json string>' }] }`. When the inner
  payload is JSON, callers see escaped quotes inside the `text` field
  (`\"key\":...`). Bash assertions like `grep -q '"key"'` will fail; use
  `grep -q key` or parse with `jq`.

- **`bug:` (`a2a` Python lib uses removed protobuf API)** — The
  `a2a` package's `utils/proto_utils.py` calls `field.label`, which
  protobuf 6.x removed (the package has a TODO comment about migrating to
  `field.is_repeated` but it hasn't shipped). On Python 3.14 with the
  current `a2a` release, requests die with
  `'FieldDescriptor' object has no attribute 'label'` regardless of the
  C-extension/pure-python toggle. Fix: pin `protobuf<6` (we run 5.29.6).
  Suggested upstream fix: complete the `is_repeated` migration in
  `a2a/utils/proto_utils.py`.

- **`gotcha:` (A2A startup ordering)** — `python -m a2a_serving.a2a_server`
  fetches `http://127.0.0.1:9002/topology` synchronously on startup to learn
  its own peer ID, so the AXL node MUST be up first. Start order: AXL → MCP
  router → MCP server → A2A server → caller AXL node.

- **`docs-gap:` (A2A response wrapping)** — A2A `SendMessage` returns a
  `Task` envelope with the actual MCP result at
  `result.task.artifacts[0].parts[0].text`. Worth documenting at
  https://docs.gensyn.ai/tech/agent-exchange-layer/integrations#a2a-server.

## 2026-04-27 — Phase 1 mesh foundation

### AXL

- **`docs-gap:` (no native pubsub primitive)** — TECHNICAL.md drafts and
  generic agent-mesh literature talk about "GossipSub" topics for fan-out
  broadcasts. AXL doesn't ship that. The HTTP surface is `/topology`,
  `/send`, `/recv`, `/mcp/{peer}/{svc}`, `/a2a/{peer}` — full stop. To
  broadcast at the application layer we walk the peer set from `/topology`
  and call the same MCP tool on every peer in turn. This works fine
  semantically and cost is acceptable at our scale (~50 peers × 1hr
  ticks), but it's worth saying so up front in the AXL docs to set
  expectations: "AXL is unicast + envelope; pubsub is your application's
  job."

- **`gotcha:` (`/topology.tree` lags `/topology.peers` asymmetrically)** —
  Yggdrasil's spanning tree updates propagate eventually-consistently. In
  a 3-node mesh with a hub (MA) and two leaf nodes (CA, TX dialing into
  MA), MA's `tree` shows all 3 nodes immediately, but CA's `tree`
  persistently shows only `[CA, MA]` for the first several minutes — TX
  is reachable via routing but not in the topology view. **Routing works
  regardless** (we ran a CA → TX MCP call to completion while CA's tree
  was 2 nodes). Worth documenting the convergence behavior in the AXL
  troubleshooting page. **Workaround:** we layered a 1-hop MCP gossip
  protocol on top — every agent exposes a `share_topology` tool returning
  its known pubkey set, and a periodic discovery loop unions own
  `/topology` with each direct peer's response. Converges in ≤10s. See
  [`packages/agent/src/discovery.ts`](packages/agent/src/discovery.ts).
  This is the pattern other AXL builders will likely need too — would be
  a nice addition to the AXL "examples" docs page.

- **`gotcha:` (AXL `GET /a2a/{peer}` forwards to `/.well-known/agent-card.json`)** —
  Not the root path. `/Users/narasim/Code/work/federated-reserve/vendor/axl/internal/a2a/a2a_utils.go:13`
  hardcodes the path. POST goes to root. A custom TS A2A server (mounted
  on `Bun.serve`) needs to handle both. Documented in a few places in the
  AXL repo but easy to miss when implementing a non-Python A2A server.

- **`delight:` (`@a2a-js/sdk` `JsonRpcTransportHandler` is a clean
  drop-in)** — `new JsonRpcTransportHandler(new DefaultRequestHandler(card,
  store, executor))` plus a Bun.serve `fetch` handler is ~80 lines for
  a working A2A server with the full v0.3.0 lifecycle, including
  multi-turn tasks (`Working → InputRequired → Completed`). Replacing the
  bundled Python `a2a_serving.a2a_server` was straightforward.

- **`gotcha:` (Bun runs `.ts` directly without type stripping)** — A
  `declare const _x: SomeType; void _x;` trick to force-keep an unused
  type import compiles fine but throws `ReferenceError: _x is not defined`
  at runtime. Bun executes the TS source as-is. Just import the type
  where you use it.

### Uniswap

_(placeholder — Spike 03 will populate this when we hit the Trading API)_

## 2026-04-28 — Phase 3 settlement (Trading API integration)

### Uniswap

- **`delight:` (mainnet quote round-trip is dead simple)** — POSTing
  `{tokenIn, tokenOut, amount, type, tokenInChainId, tokenOutChainId, swapper}`
  to `/v1/quote` with `x-api-key` and `x-universal-router-version: 2.0`
  headers returned a full CLASSIC quote with embedded Permit2 EIP-712
  typed data in the first attempt. No SDK needed. The
  `permitData.values.{details, spender, sigDeadline}` shape is exactly
  what `viem.signTypedData` consumes — the cleanest API surface I've
  hit on this hackathon. Probe: 1 USDC → WETH on Ethereum mainnet
  (chain 1) returned a Permit2-ready quote in <500ms.

- **`docs-gap:` (testnet support claim vs. reality)** — The official
  supported-chains page (https://api-docs.uniswap.org/guides/supported_chains)
  lists Unichain Sepolia (1301), Base Sepolia (84532), and Ethereum
  Sepolia (11155111) as supported. But probing chain 1301 with mainnet
  USDC/WETH addresses returns
  `404 {"errorCode":"ResourceNotFound","detail":"No quotes available"}`.
  This is _correct behavior_ (those addresses don't exist on testnet) —
  but the error is identical to the one you'd get on a genuinely
  unsupported chain. A more helpful response would distinguish "chain
  unsupported" (e.g. 400 with `errorCode: ChainNotSupported`) from
  "no liquidity for this pair" (the current 404). When you're trying to
  validate testnet integration before deploying contracts, this
  ambiguity costs an hour of debugging.

- **`delight:` (Trading API indexes our brand-new testnet V3 pools
  within ~30 seconds of LP)** — We deployed a fresh ERC-20 pair
  (MockUSDC + per-state Treasury Tokens) on Unichain Sepolia (chain
  1301), seeded a V3 pool via the canonical NonfungiblePositionManager
  (`0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075`) with full-range LP at
  fee 3000, and the Trading API's `/v1/quote` returned a complete
  CLASSIC route through the new pool address on the very next
  request — Permit2 EIP-712 typed data, full route metadata
  (`route[0][0].address` exactly matched the pool we created), output
  amount, gas estimate, all of it. No subgraph wait, no manual
  registration. This is the best possible outcome for a hackathon —
  freshly deployed liquidity is routable through the same API path
  judges will see in the recording.

- **`docs-gap:` (`routingPreference` schema mismatch with skill docs)** —
  The Uniswap-published `swap-integration` SKILL.md
  (`packages/plugins/uniswap-trading/skills/swap-integration/SKILL.md`,
  v1.3.0) lists three values for `routingPreference`: `BEST_PRICE`,
  `FASTEST`, and `CLASSIC`. Sending `"routingPreference": "CLASSIC"`
  with `"protocols": ["V3"]` returns
  `400 {"errorCode":"RequestValidationError","detail":"\"routingPreference\" must be one of [BEST_PRICE, FASTEST]"}`.
  Either the skill needs to drop CLASSIC from the enum, or the API
  needs to accept it. Workaround: omit `routingPreference` entirely;
  the API still returns CLASSIC routing for V3-only pools, since
  there's nothing else to route through on a fresh testnet.

- **`bug:` (Trading API CLASSIC `swap.gasLimit` is occasionally too
  tight for the inner pool ERC-20 transfer)** — On Unichain Sepolia
  chain 1301, our second swap from a freshly-Permit2-approved wallet
  came back with a `gasLimit` low enough that the V3 pool's inner
  `safeTransfer` to the recipient hit `OutOfGas` and reverted with
  Uniswap's "TF" error. cast trace:
  `pool.swap(...) → ERC20.transfer(recipient, ...) ↘ [OutOfGas]
  → revert "TF"`. Smoke-test of the same `/swap` calldata pattern
  worked because that call had a higher returned `gasLimit`; the
  responder-side swap fired ~5s later got a tighter estimate. Two
  observations: (1) the API estimate doesn't add headroom for the
  recipient-side transfer when the recipient is a contract or has
  unusual code, and (2) the SwapRouter shell shouldn't return success
  for the outer call frame when the inner `transfer` ran out of gas —
  it does, leaving us a "succeeded" return value with status 0 in
  the receipt. Workaround: ignore `swap.gasLimit`, run
  `eth_estimateGas` ourselves, add a 25% headroom, then send.
  Suggested fix: bake recipient-aware buffer into the API's quoted
  gasLimit (or surface a separate `gasLimitMin`/`gasLimitRecommended`
  pair). Real cost: ~0.001 ETH wasted, plus an hour of debugging
  before reading the trace.

- **`delight:` (full quote→permit-sign→swap→broadcast loop is ~15
  lines)** — The end-to-end Trading API flow for a CLASSIC route:
  `POST /check_approval` returns one ERC-20 approval calldata blob,
  `POST /quote` returns the EIP-712 typed-data permit bundle exactly
  shaped for `viem.signTypedData({ primaryType: 'PermitSingle' })`,
  `POST /swap` returns ready-to-broadcast tx calldata, and we sign +
  send via viem. First swap from a fresh wallet on Unichain Sepolia:
  1 USDC in, 0.997 MAT out, tx confirmed in ~6s
  (`0xfa1dbe…fb706` on
  https://unichain-sepolia.blockscout.com). Total custom Solidity:
  zero. Total custom routing/pricing logic: zero. The API does the
  hard parts and the SDK boundary lands exactly where you'd want it.

- **`gotcha:` (RPC stale-read after `createAndInitializePoolIfNecessary`
  bricks a same-block follow-up `mint`)** — Unichain Sepolia's public
  RPC (`https://sepolia.unichain.org`) takes 1-3s to propagate writes.
  We seeded 5 V3 pools with the standard pattern
  (`createAndInitializePoolIfNecessary` → `mint` in sequence). 2 of 5
  succeeded; 3 reverted with the pool's `slot0.sqrtPriceX96` reading
  zero from the same RPC node that just confirmed the init. Pattern
  was non-deterministic across runs (different states succeeded each
  attempt). Workaround: poll `slot0` until non-zero before issuing the
  mint, or insert a 2-3s sleep. Better long-term fix: NPM should
  expose a `createInitMintAndBurn` style multicall that bundles all
  three ops in one tx, eliminating the cross-tx visibility race. Not
  strictly a Uniswap bug — it's a Unichain RPC consistency issue —
  but anyone copying the V3 LP recipe verbatim will hit it on testnet.

### 0G

_(placeholder — Spike 05 will populate this when we deploy ERC-721 on 0G testnet)_

### Data sources

_(placeholder — Spike 04 will populate this when we hit FRED)_
