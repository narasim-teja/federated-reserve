# Spike 00 — Two AXL nodes, peering + /send /recv round-trip

**Status:** ✅ PASS

## What it proves

1. The AXL node binary builds (`make build` from `vendor/axl/`) and starts.
2. Two nodes can peer over local TLS without an external bootstrap
   (one `Listen`s on `tls://127.0.0.1:9001`, the other `Peers` to that URI).
3. `/topology` returns each node's `our_public_key`.
4. `POST /send` (fire-and-forget) → `GET /recv` (poll) round-trips a raw byte
   payload between the two nodes.

## Run

```bash
./spikes/00-axl-nodes/run.sh         # run the spike end-to-end
./spikes/00-axl-nodes/run.sh stop    # kill leftover node processes
```

Logs land at `/tmp/spike-00-node-{a,b}.log`.

## Files

- [`configs/node-a.json`](./configs/node-a.json) — listener on `tls://127.0.0.1:9001`, API on `:9002`
- [`configs/node-b.json`](./configs/node-b.json) — peers to A, API on `:9012`
- [`run.sh`](./run.sh) — orchestrates start, peering check, send/recv

## Lessons learned (folded into FEEDBACK.md)

1. **`tcp_port` must match across nodes.** `api/send.go` dials peers using the
   *local* node's `tcp_port` as the destination port. The public AXL docs
   suggest different `tcp_port` values for same-machine local tests, which
   breaks `/send`. Fix: both nodes set `tcp_port: 7000`. gVisor TCP is virtual
   per-process so the host port doesn't conflict.

2. **Yggdrasil peering is fast (~1s) but gVisor TCP needs more settle time
   (~3-6s).** Even after `/topology` lists the peer, an immediate `/send`
   may briefly return 502 with "connection was refused" before the gVisor
   TCP listener accepts. Spike retries 8× with 2s backoff.

3. **Local 2-node test needs explicit `Listen`/`Peers`.** The public
   get-started page omits these for the 2nd node, which leaves both nodes
   with empty peer lists.
