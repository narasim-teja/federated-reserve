#!/usr/bin/env bash
# Spike 02 — A2A-over-AXL via the bundled Python A2A server.
#
# Architecture (same node A as spike 01, plus A2A server):
#   Node A:
#     - AXL :9002  (router_addr → :9003, a2a_addr → :9004)
#     - Python MCP Router :9003
#     - TS MCP server :7100 ("treasurer")
#     - Python A2A Server :9004 (auto-discovers from router, fetches own peer
#       ID from local /topology — must be started AFTER AXL is up)
#   Node B:
#     - AXL :9012 — calls /a2a/{A_pubkey}
#
# Tests:
#   1. GET /a2a/{A_pubkey} returns an A2A agent card listing "treasurer".
#   2. POST /a2a/{A_pubkey} with the wrapped MCP envelope returns the
#      treasury composition.
#
# Usage:
#   ./spikes/02-axl-a2a/run.sh
#   ./spikes/02-axl-a2a/run.sh stop

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$ROOT/vendor/axl/node"
SPIKE_DIR="$ROOT/spikes/02-axl-a2a"
MCP_SPIKE_DIR="$ROOT/spikes/01-axl-mcp"
CONFIG_DIR="$SPIKE_DIR/configs"
PID_FILE="/tmp/federated-reserve-spike-02.pids"
LOG_DIR="/tmp"

cmd="${1:-run}"

cleanup() {
  echo "[spike-02] stopping..."
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  for port in 9001 9002 9012 7000 9003 9004 7100; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

if [[ "$cmd" == "stop" ]]; then cleanup; echo "[spike-02] stopped."; exit 0; fi
trap cleanup EXIT

[[ -x "$NODE_BIN" ]] || { echo "ERROR: AXL binary missing"; exit 1; }
[[ -d "$ROOT/.venv" ]] || { echo "ERROR: .venv missing"; exit 1; }
[[ -d "$MCP_SPIKE_DIR/node_modules" ]] || { echo "ERROR: spike-01 node_modules missing"; exit 1; }

cleanup
sleep 1
> "$PID_FILE"

# ---------- Step 1: AXL node A ----------
# A2A server queries /topology on startup, so AXL must be up first.
echo "[spike-02] starting AXL node A on :9002..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-a.json ) > "$LOG_DIR/spike-02-node-a.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..15}; do
  curl -fsS http://127.0.0.1:9002/topology > /dev/null 2>&1 && { echo "  - node A ✓"; break; }
  if [[ $i -eq 15 ]]; then echo "  - node A ✗"; tail -30 "$LOG_DIR/spike-02-node-a.log"; exit 1; fi
  sleep 0.5
done

# ---------- Step 2: Python MCP Router ----------
echo "[spike-02] starting Python MCP router on :9003..."
( source "$ROOT/.venv/bin/activate" && python -m mcp_routing.mcp_router --port 9003 ) > "$LOG_DIR/spike-02-router.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..15}; do
  curl -fsS http://127.0.0.1:9003/health > /dev/null 2>&1 && { echo "  - router ✓"; break; }
  if [[ $i -eq 15 ]]; then echo "  - router ✗"; tail -30 "$LOG_DIR/spike-02-router.log"; exit 1; fi
  sleep 0.5
done

# ---------- Step 3: TS MCP server (reused from spike 01) ----------
echo "[spike-02] starting TS MCP server on :7100..."
( cd "$MCP_SPIKE_DIR" && MCP_ROUTER_URL=http://127.0.0.1:9003 MCP_SERVICE_PORT=7100 MCP_SERVICE_NAME=treasurer bun run server.ts ) > "$LOG_DIR/spike-02-mcp-server.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..20}; do
  curl -fsS http://127.0.0.1:9003/services 2>/dev/null | grep -q treasurer && { echo "  - mcp-server registered ✓"; break; }
  if [[ $i -eq 20 ]]; then echo "  - mcp-server ✗"; tail -30 "$LOG_DIR/spike-02-mcp-server.log"; exit 1; fi
  sleep 0.5
done

# ---------- Step 4: Python A2A server ----------
echo "[spike-02] starting Python A2A server on :9004 (router=:9003)..."
# PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python forces the pure-Python protobuf
# runtime, which avoids a Python 3.14 incompatibility in the C-extension
# (`google._upb._message.FieldDescriptor.label` was removed). See FEEDBACK.md.
( source "$ROOT/.venv/bin/activate" && PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python python -m a2a_serving.a2a_server --port 9004 --router http://127.0.0.1:9003 ) > "$LOG_DIR/spike-02-a2a-server.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..20}; do
  if curl -fsS http://127.0.0.1:9004/.well-known/agent-card.json > /dev/null 2>&1; then
    echo "  - a2a-server ✓"; break
  fi
  if [[ $i -eq 20 ]]; then echo "  - a2a-server ✗"; tail -40 "$LOG_DIR/spike-02-a2a-server.log"; exit 1; fi
  sleep 0.5
done

# ---------- Step 5: AXL node B (caller) ----------
echo "[spike-02] starting AXL node B on :9012..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-b.json ) > "$LOG_DIR/spike-02-node-b.log" 2>&1 &
echo $! >> "$PID_FILE"

for i in {1..15}; do
  curl -fsS http://127.0.0.1:9012/topology > /dev/null 2>&1 && { echo "  - node B ✓"; break; }
  if [[ $i -eq 15 ]]; then echo "  - node B ✗"; exit 1; fi
  sleep 1
done

sleep 6 # gVisor TCP settle

NODE_A_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
NODE_B_KEY=$(curl -s http://127.0.0.1:9012/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
echo "[spike-02] node A pubkey: $NODE_A_KEY"
echo "[spike-02] node B pubkey: $NODE_B_KEY"

RESP_FILE=$(mktemp)

# ---------- Test 1: GET /a2a/{A_pubkey} → agent card ----------
echo ""
echo "[spike-02] [test 1] GET /a2a/$NODE_A_KEY (agent-card discovery)"
CARD_RESP=""
for attempt in {1..8}; do
  CODE=$(curl -sS -X GET "http://127.0.0.1:9012/a2a/$NODE_A_KEY" \
    -o "$RESP_FILE" -w '%{http_code}' || echo "000")
  BODY=$(cat "$RESP_FILE")
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$BODY" | head -c 200)"
  if [[ "$CODE" == "200" ]]; then CARD_RESP="$BODY"; break; fi
  sleep 2
done

if [[ -z "$CARD_RESP" ]]; then
  echo "[spike-02] FAIL: agent card never returned 200"
  echo "--- a2a-server log ---"; tail -40 "$LOG_DIR/spike-02-a2a-server.log"
  exit 1
fi

if echo "$CARD_RESP" | grep -q treasurer; then
  echo "[spike-02]   ✓ agent card advertises 'treasurer' skill"
else
  echo "[spike-02]   ✗ agent card missing 'treasurer'"
  echo "$CARD_RESP" | head -c 500
  exit 1
fi

# ---------- Test 2: POST /a2a/{A_pubkey} with wrapped MCP envelope ----------
echo ""
echo "[spike-02] [test 2] POST /a2a/$NODE_A_KEY (SendMessage → treasurer.tools/call)"

INNER='{"service":"treasurer","request":{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"query_treasury","arguments":{"state_fips":25}}}}'
INNER_ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$INNER")
A2A_REQ='{"jsonrpc":"2.0","method":"SendMessage","id":2,"params":{"message":{"role":"ROLE_USER","parts":[{"text":'"$INNER_ESCAPED"'}],"messageId":"spike-02-test"}}}'

CALL_RESP=""
for attempt in {1..5}; do
  CODE=$(curl -sS -X POST "http://127.0.0.1:9012/a2a/$NODE_A_KEY" \
    -H "Content-Type: application/json" \
    -d "$A2A_REQ" -o "$RESP_FILE" -w '%{http_code}' || echo "000")
  BODY=$(cat "$RESP_FILE")
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$BODY" | head -c 200)"
  if [[ "$CODE" == "200" ]]; then CALL_RESP="$BODY"; break; fi
  sleep 2
done

rm -f "$RESP_FILE"

if [[ -z "$CALL_RESP" ]]; then
  echo "[spike-02] FAIL: A2A SendMessage never returned 200"
  echo "--- a2a-server log ---"; tail -40 "$LOG_DIR/spike-02-a2a-server.log"
  echo "--- mcp-server log ---"; tail -20 "$LOG_DIR/spike-02-mcp-server.log"
  exit 1
fi

if echo "$CALL_RESP" | grep -q reserve_ratio; then
  echo "[spike-02]   ✓ A2A response wraps treasury composition"
else
  echo "[spike-02]   ✗ unexpected A2A response: $(echo "$CALL_RESP" | head -c 400)"
  exit 1
fi

echo ""
echo "[spike-02] PASS — bundled A2A server reachable from peer over AXL transport"
echo "[spike-02] logs at $LOG_DIR/spike-02-*.log"
