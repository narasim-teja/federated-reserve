# Spike 01 — MCP-over-AXL with `@modelcontextprotocol/sdk`

**Status:** ✅ PASS

## What it proves

A TypeScript MCP server built with the official `@modelcontextprotocol/sdk`
is reachable from a peer node over the AXL transport, with the bundled
Python `mcp_routing.mcp_router` as the bridge. Both `tools/list` and
`tools/call` round-trip correctly.

This is the load-bearing architectural validation for the whole project:
**we can use the official MCP SDK, on Bun, with AXL doing all the P2P
transport, and zero custom protocol code.**

## Architecture

```
   Node B (caller)                       Node A (server)
┌──────────────────┐                ┌──────────────────────────┐
│ curl POST        │   AXL/Yggdr.   │ AXL node :9002           │
│ /mcp/{A}/treasurer ────────────►  │  (router_addr :9003)     │
│ {tools/call ...}  │                │           │              │
│                  │                 │           ▼              │
│                  │                 │ Python MCP Router :9003  │
│                  │                 │           │              │
│                  │                 │           ▼              │
│                  │                 │ TS MCP server :7100      │
│                  │                 │  (@modelcontextprotocol/ │
│                  │                 │   sdk + Bun)             │
└──────────────────┘                 └──────────────────────────┘
```

## Run

```bash
cd spikes/01-axl-mcp && bun install   # one-time
./spikes/01-axl-mcp/run.sh             # run end-to-end
./spikes/01-axl-mcp/run.sh stop        # kill leftover processes
```

Logs land at `/tmp/spike-01-{router,mcp-server,node-a,node-b}.log`.

## Files

- [`server.ts`](./server.ts) — TS MCP server using `McpServer` +
  `WebStandardStreamableHTTPServerTransport`. Registers with the router on
  startup, deregisters on SIGINT/SIGTERM. Exposes one tool `query_treasury`.
- [`configs/node-a.json`](./configs/node-a.json),
  [`configs/node-b.json`](./configs/node-b.json) — AXL node configs (same as
  spike 00 but with `router_addr` actually used).
- [`run.sh`](./run.sh) — orchestrates router → MCP server → AXL nodes →
  call from B → assert.
- [`package.json`](./package.json) — Bun deps: MCP SDK, Hono (unused in this
  spike but available), Zod.

## Lessons learned (folded into FEEDBACK.md)

1. **Stateless transport is single-use** — The MCP SDK's
   `WebStandardStreamableHTTPServerTransport`, when configured with
   `sessionIdGenerator: undefined` (stateless), throws
   `"Stateless transport cannot be reused across requests"` on the second
   call. Pattern: instantiate a fresh `McpServer` + transport per HTTP
   request. Slightly wasteful but correct for our use case (AXL-fronted
   APIs have no client-controlled session lifecycle).
2. **The `webStandardStreamableHttp` transport pairs perfectly with Bun.**
   `transport.handleRequest(req: Request): Promise<Response>` is web-standard
   and drops straight into `Bun.serve({ fetch })` — no Node `http` interop
   needed.
3. **Router registration is a 5-line HTTP POST.** No SDK or library
   needed; the Python router's `POST /register {service, endpoint}` API is
   simple and we wrap it with retries to handle startup ordering.
4. **MCP `tools/call` responses wrap text in JSON-stringified envelopes.**
   When the inner result is JSON, you get escaped quotes
   (`\"reserve_ratio\":`) inside the `content[0].text` field. Test
   assertions need to match without quotes (`grep -q reserve_ratio`).
