#!/usr/bin/env bash
# Spike 01 — MCP-over-AXL.
#
# Architecture:
#   Node A (server side):
#     - AXL node on api :9002, listen :9001 (router_addr → :9003)
#     - Python MCP Router on :9003
#     - TS MCP server on :7100 (uses @modelcontextprotocol/sdk),
#       registers itself with the router as service "treasurer"
#   Node B (client side):
#     - AXL node on api :9012, peers to A
#     - Calls POST /mcp/{A_pubkey}/treasurer with JSON-RPC tools/list and tools/call
#
# Proves: a TS @modelcontextprotocol/sdk server can serve a peer over the AXL
# transport, with the bundled Python MCP Router as the bridge.
#
# Usage:
#   ./spikes/01-axl-mcp/run.sh           # run end-to-end
#   ./spikes/01-axl-mcp/run.sh stop      # kill leftovers

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$ROOT/vendor/axl/node"
SPIKE_DIR="$ROOT/spikes/01-axl-mcp"
CONFIG_DIR="$SPIKE_DIR/configs"
PID_FILE="/tmp/federated-reserve-spike-01.pids"
LOG_DIR="/tmp"

cmd="${1:-run}"

cleanup() {
  echo "[spike-01] stopping..."
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  for port in 9001 9002 9012 7000 9003 7100; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

if [[ "$cmd" == "stop" ]]; then
  cleanup
  echo "[spike-01] stopped."
  exit 0
fi

trap cleanup EXIT

# ---------- Preflight ----------
[[ -x "$NODE_BIN" ]] || { echo "ERROR: AXL binary missing — run 'make build' in vendor/axl"; exit 1; }
[[ -d "$ROOT/.venv" ]] || { echo "ERROR: .venv missing — create + pip install -e vendor/axl/integrations"; exit 1; }
[[ -d "$SPIKE_DIR/node_modules" ]] || { echo "ERROR: bun install missing in spike — run: cd $SPIKE_DIR && bun install"; exit 1; }

cleanup
sleep 1
> "$PID_FILE"

# ---------- Step 1: Python MCP Router ----------
echo "[spike-01] starting Python MCP router on :9003..."
( source "$ROOT/.venv/bin/activate" && python -m mcp_routing.mcp_router --port 9003 ) > "$LOG_DIR/spike-01-router.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..15}; do
  if curl -fsS http://127.0.0.1:9003/health > /dev/null 2>&1; then
    echo "  - router ✓"; break
  fi
  if [[ $i -eq 15 ]]; then echo "  - router ✗ (timeout)"; tail -30 "$LOG_DIR/spike-01-router.log"; exit 1; fi
  sleep 0.5
done

# ---------- Step 2: TS MCP server (registers with router on startup) ----------
echo "[spike-01] starting TS MCP server on :7100..."
( cd "$SPIKE_DIR" && MCP_ROUTER_URL=http://127.0.0.1:9003 MCP_SERVICE_PORT=7100 MCP_SERVICE_NAME=treasurer bun run server.ts ) > "$LOG_DIR/spike-01-mcp-server.log" 2>&1 &
echo $! >> "$PID_FILE"

# Wait for the server to register with the router
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:9003/services 2>/dev/null | grep -q treasurer; then
    echo "  - registered ✓"; break
  fi
  if [[ $i -eq 20 ]]; then
    echo "  - registration ✗ (timeout)"
    tail -30 "$LOG_DIR/spike-01-mcp-server.log"
    exit 1
  fi
  sleep 0.5
done

# ---------- Step 3: Two AXL nodes ----------
echo "[spike-01] starting AXL node A (server side)..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-a.json ) > "$LOG_DIR/spike-01-node-a.log" 2>&1 &
echo $! >> "$PID_FILE"
sleep 2

echo "[spike-01] starting AXL node B (client side)..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-b.json ) > "$LOG_DIR/spike-01-node-b.log" 2>&1 &
echo $! >> "$PID_FILE"

for url in http://127.0.0.1:9002/topology http://127.0.0.1:9012/topology; do
  for i in {1..15}; do
    if curl -fsS "$url" > /dev/null 2>&1; then echo "  - $url ✓"; break; fi
    if [[ $i -eq 15 ]]; then echo "  - $url ✗"; exit 1; fi
    sleep 1
  done
done

sleep 6 # gVisor TCP settle

NODE_A_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
NODE_B_KEY=$(curl -s http://127.0.0.1:9012/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
echo "[spike-01] node A pubkey: $NODE_A_KEY"
echo "[spike-01] node B pubkey: $NODE_B_KEY"

# ---------- Step 4: tools/list from B → A's "treasurer" service ----------
echo ""
echo "[spike-01] [test 1] tools/list from B → A:treasurer"
LIST_REQ='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
LIST_RESP=""
RESP_FILE=$(mktemp)
for attempt in {1..8}; do
  CODE=$(curl -sS -X POST "http://127.0.0.1:9012/mcp/$NODE_A_KEY/treasurer" \
    -H "Content-Type: application/json" \
    -d "$LIST_REQ" -o "$RESP_FILE" -w '%{http_code}' || echo "000")
  BODY=$(cat "$RESP_FILE")
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$BODY" | head -c 200)"
  if [[ "$CODE" == "200" ]]; then
    LIST_RESP="$BODY"
    break
  fi
  sleep 2
done
rm -f "$RESP_FILE"

if [[ -z "$LIST_RESP" ]]; then
  echo "[spike-01] FAIL: tools/list never returned 200"
  echo "--- mcp-server log ---"; tail -40 "$LOG_DIR/spike-01-mcp-server.log"
  echo "--- router log ---"; tail -30 "$LOG_DIR/spike-01-router.log"
  echo "--- node A log ---"; tail -30 "$LOG_DIR/spike-01-node-a.log"
  exit 1
fi

if echo "$LIST_RESP" | grep -q query_treasury; then
  echo "[spike-01]   ✓ response advertises query_treasury tool"
else
  echo "[spike-01]   ✗ response missing query_treasury"
  echo "$LIST_RESP"
  exit 1
fi

# ---------- Step 5: tools/call query_treasury ----------
echo ""
echo "[spike-01] [test 2] tools/call query_treasury(state_fips=25) from B → A:treasurer"
CALL_REQ='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_treasury","arguments":{"state_fips":25}}}'
CALL_RESP=$(curl -sS -X POST "http://127.0.0.1:9012/mcp/$NODE_A_KEY/treasurer" \
  -H "Content-Type: application/json" \
  -d "$CALL_REQ")

if echo "$CALL_RESP" | grep -q 'reserve_ratio'; then
  echo "[spike-01]   ✓ response contains treasury composition"
  echo "[spike-01]   sample: $(echo "$CALL_RESP" | head -c 300)..."
else
  echo "[spike-01]   ✗ unexpected response: $CALL_RESP"
  exit 1
fi

echo ""
echo "[spike-01] PASS — TS MCP server reachable from peer over AXL transport"
echo "[spike-01] logs at $LOG_DIR/spike-01-*.log"
