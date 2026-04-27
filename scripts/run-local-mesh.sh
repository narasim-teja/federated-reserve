#!/usr/bin/env bash
# Phase 1 local mesh: 3 AXL nodes + 3 MCP routers + 3 agent processes (MA, CA, TX).
#
# Topology:
#   MA (FIPS 25): AXL :9002 listen :9001  | router :9003  | mcp :7100  | a2a :9004
#   CA (FIPS  6): AXL :9012 peers→:9001   | router :9013  | mcp :7110  | a2a :9014
#   TX (FIPS 48): AXL :9022 peers→:9001   | router :9023  | mcp :7120  | a2a :9024
#
# All AXL nodes share `tcp_port: 7000` per the Phase 0 finding (gVisor TCP is
# virtual per-process, and AXL's send dialer uses *its own* tcp_port as the
# destination port).
#
# Usage:
#   ./scripts/run-local-mesh.sh           # boot everything; foreground
#   ./scripts/run-local-mesh.sh stop      # kill any leftover processes/ports
#   ./scripts/run-local-mesh.sh status    # quick health probe of each agent

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$ROOT/vendor/axl/node"
CONFIG_DIR="$ROOT/mesh/configs"
KEY_DIR="$ROOT/.keys"
PID_FILE="/tmp/federated-reserve-mesh.pids"
LOG_DIR="${LOG_DIR:-/tmp/federated-reserve}"
mkdir -p "$LOG_DIR"

cmd="${1:-run}"

# ---------- agents -----------------------------------------------------------
# name, fips, axl_api, axl_listen, router, mcp, a2a, key_pem, config
AGENTS=(
  "MA 25 9002 9001 9003 7100 9004 node-ma.pem node-ma.json"
  "CA  6 9012 9011 9013 7110 9014 node-ca.pem node-ca.json"
  "TX 48 9022 9021 9023 7120 9024 node-tx.pem node-tx.json"
)

ALL_PORTS=(9001 9002 9011 9012 9021 9022 7000 9003 9013 9023 7100 7110 7120 9004 9014 9024)

cleanup() {
  echo "[mesh] stopping..."
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  for port in "${ALL_PORTS[@]}"; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

if [[ "$cmd" == "stop" ]]; then
  cleanup
  echo "[mesh] stopped."
  exit 0
fi

if [[ "$cmd" == "status" ]]; then
  for entry in "${AGENTS[@]}"; do
    read -r name _fips axl_api _listen _router _mcp _a2a _key _cfg <<<"$entry"
    if curl -fsS "http://127.0.0.1:$axl_api/topology" >/dev/null 2>&1; then
      pubkey=$(curl -s "http://127.0.0.1:$axl_api/topology" | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"][:16])' 2>/dev/null || echo "?")
      echo "  $name  AXL :$axl_api ✓ (pubkey=${pubkey}…)"
    else
      echo "  $name  AXL :$axl_api ✗"
    fi
  done
  exit 0
fi

# ---------- Preflight --------------------------------------------------------
[[ -x "$NODE_BIN" ]] || { echo "ERROR: AXL binary missing at $NODE_BIN — run 'cd vendor/axl && make build'"; exit 1; }
[[ -d "$ROOT/.venv" ]] || { echo "ERROR: .venv missing — Phase 0 spike-01 readme has setup"; exit 1; }
[[ -d "$ROOT/packages/agent/node_modules" ]] || { echo "ERROR: bun install missing — run 'bun install' at repo root"; exit 1; }

# Generate any missing keys.
for entry in "${AGENTS[@]}"; do
  read -r _name _fips _api _listen _router _mcp _a2a key _cfg <<<"$entry"
  if [[ ! -f "$KEY_DIR/$key" ]]; then
    echo "[mesh] generating $KEY_DIR/$key"
    openssl genpkey -algorithm ed25519 -out "$KEY_DIR/$key" >/dev/null 2>&1
  fi
done

trap cleanup EXIT

cleanup
sleep 1
> "$PID_FILE"

# ---------- Step 1: AXL nodes ------------------------------------------------
# Start the listener (MA) first so the others can peer.
for entry in "${AGENTS[@]}"; do
  read -r name _fips api _listen _router _mcp _a2a _key cfg <<<"$entry"
  echo "[mesh] starting AXL node $name on api :$api (config $cfg)"
  ( cd "$CONFIG_DIR" && "$NODE_BIN" -config "$cfg" ) > "$LOG_DIR/axl-$name.log" 2>&1 &
  echo $! >> "$PID_FILE"
  for i in {1..15}; do
    if curl -fsS "http://127.0.0.1:$api/topology" > /dev/null 2>&1; then
      echo "  - $name AXL ready"
      break
    fi
    if [[ $i -eq 15 ]]; then
      echo "  - $name AXL FAILED to come up"
      tail -30 "$LOG_DIR/axl-$name.log"
      exit 1
    fi
    sleep 0.5
  done
done

# ---------- Step 2: MCP Routers (one per agent host) ------------------------
for entry in "${AGENTS[@]}"; do
  read -r name _fips _api _listen router _mcp _a2a _key _cfg <<<"$entry"
  echo "[mesh] starting MCP router for $name on :$router"
  ( source "$ROOT/.venv/bin/activate" && python -m mcp_routing.mcp_router --port "$router" ) > "$LOG_DIR/router-$name.log" 2>&1 &
  echo $! >> "$PID_FILE"
  for i in {1..15}; do
    if curl -fsS "http://127.0.0.1:$router/health" > /dev/null 2>&1; then
      echo "  - $name router ready"
      break
    fi
    if [[ $i -eq 15 ]]; then
      echo "  - $name router FAILED"
      tail -30 "$LOG_DIR/router-$name.log"
      exit 1
    fi
    sleep 0.5
  done
done

# ---------- Step 3: Agent processes (each runs MCP server + A2A server) -----
for entry in "${AGENTS[@]}"; do
  read -r name fips api _listen router mcp a2a _key _cfg <<<"$entry"
  echo "[mesh] starting agent $name (FIPS $fips)"
  (
    cd "$ROOT/packages/agent" && \
    STATE_FIPS="$fips" \
    AXL_API_URL="http://127.0.0.1:$api" \
    MCP_ROUTER_URL="http://127.0.0.1:$router" \
    MCP_SERVER_PORT="$mcp" \
    A2A_SERVER_PORT="$a2a" \
    TICK_INTERVAL_MS="${TICK_INTERVAL_MS:-30000}" \
    bun run src/index.ts
  ) > "$LOG_DIR/agent-$name.log" 2>&1 &
  echo $! >> "$PID_FILE"
done

# Wait for all agents to register.
for entry in "${AGENTS[@]}"; do
  read -r name _fips _api _listen router _mcp _a2a _key _cfg <<<"$entry"
  for i in {1..30}; do
    if curl -fsS "http://127.0.0.1:$router/services" 2>/dev/null | grep -q treasurer; then
      echo "  - $name registered with router :$router"
      break
    fi
    if [[ $i -eq 30 ]]; then
      echo "  - $name FAILED to register"
      tail -40 "$LOG_DIR/agent-$name.log"
      exit 1
    fi
    sleep 0.5
  done
done

# Allow gVisor TCP to settle so the first /send between peers doesn't drop.
echo "[mesh] waiting 6s for gVisor TCP settle..."
sleep 6

echo ""
echo "[mesh] ✓ ready"
echo "[mesh]    logs:  $LOG_DIR/{axl,router,agent}-*.log"
echo "[mesh]    stop:  $0 stop"
echo "[mesh]    pubkeys:"
for entry in "${AGENTS[@]}"; do
  read -r name _fips api _listen _router _mcp _a2a _key _cfg <<<"$entry"
  pubkey=$(curl -s "http://127.0.0.1:$api/topology" | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
  echo "[mesh]      $name  $pubkey"
done

# Hold the foreground; cleanup runs on Ctrl+C via trap.
echo ""
echo "[mesh] (Ctrl+C to stop)"
wait
