# Spike 02 — A2A-over-AXL via the bundled Python A2A server

**Status:** ✅ PASS

## What it proves

The bundled `a2a_serving.a2a_server` (Python) auto-discovers MCP services
from the Python MCP Router and exposes them as A2A skills. A peer can:

1. `GET /a2a/{peer_id}` to discover the agent card (and skills).
2. `POST /a2a/{peer_id}` with the wrapped MCP envelope to invoke a skill.

Both round-trip correctly through real AXL transport.

## Architecture

```
   Node B               Node A
┌──────────┐    ┌────────────────────────────────────────┐
│          │ A2A│ AXL :9002 (a2a_addr → :9004)           │
│  GET     ───►│         │                                │
│  /a2a/{A}│    │         ▼                                │
│          │    │ Python A2A server :9004 ──► /topology  │
│          │    │   (auto-discovers from MCP Router)     │
│  POST    │    │         │                                │
│  /a2a/{A}│ A2A│         ▼                                │
│  {...}   │ ──►│ Python MCP Router :9003                 │
│          │    │         │                                │
│          │    │         ▼                                │
│          │    │ TS MCP server :7100 (treasurer)        │
└──────────┘    └────────────────────────────────────────┘
```

## Run

```bash
./spikes/02-axl-a2a/run.sh                # run end-to-end
./spikes/02-axl-a2a/run.sh stop           # kill leftovers
```

Logs land at `/tmp/spike-02-{router,mcp-server,a2a-server,node-a,node-b}.log`.

## Files

- [`configs/`](./configs/) — same AXL configs as spike 01 (relies on
  `a2a_addr`/`a2a_port` already set there).
- [`run.sh`](./run.sh) — orchestrates `AXL-A → router → MCP-server → A2A-server → AXL-B`
  in that order (the A2A server fetches its own peer ID from
  `127.0.0.1:9002/topology` on startup, so AXL must be up first).
- Reuses [`spikes/01-axl-mcp/server.ts`](../01-axl-mcp/server.ts) as the MCP
  service, registered as `treasurer`.

## Lessons learned (folded into FEEDBACK.md)

1. **Startup ordering matters.** The A2A server immediately calls
   `GET /127.0.0.1:9002/topology` to learn its own peer ID. If AXL isn't
   up yet, startup fails. Order: AXL node → router → MCP server → A2A server → caller node.
2. **`a2a` library is incompatible with protobuf ≥ 6.** The library's
   `a2a/utils/proto_utils.py` uses `field.label` which protobuf removed in
   the 6.x line (replaced by `field.is_repeated`). The library has a TODO
   comment about migrating but hasn't. Fix: pin `protobuf<6` in our `.venv`
   (we use 5.29.6).
3. **A2A `SendMessage` returns a `Task` envelope.** The actual MCP response
   lives at `result.task.artifacts[0].parts[0].text` after a chain of
   wrapping. The A2A protocol layers task lifecycle metadata around the
   inner result.
