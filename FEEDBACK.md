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
  was still 2 nodes). Application-level discovery should not assume
  `/topology.tree` is complete; for hackathon timeline we sidestep by
  having the test harness gather peer pubkeys from the hub. Production
  agents need a small `share_topology` MCP tool that gossips the full set
  every few seconds. Worth documenting the convergence behavior in the
  troubleshooting page.

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

### 0G

_(placeholder — Spike 05 will populate this when we deploy ERC-721 on 0G testnet)_

### Data sources

_(placeholder — Spike 04 will populate this when we hit FRED)_
