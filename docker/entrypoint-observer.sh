#!/usr/bin/env bash
# Federated Reserve observer — container entrypoint.
#
# The observer joins the mesh as a peer (AXL node + MCP router sidecars,
# same layout as a state-treasurer agent) and exposes:
#   :3001  HTTP — events feed + websocket stream (consumed by the frontend)
#   :7200  MCP server — peers POST events here
#
# Required env:
#   AXL_PEERS         comma-separated tls:// peer URLs (other agents)
#
# Optional env (defaults below):
#   AGENT_ABBR        observer
#   AXL_LISTEN_PORT   9001
#   AXL_API_PORT      9002
#   MCP_ROUTER_PORT   9003
#   OBSERVER_PORT     3001
#   OBSERVER_MCP_PORT 7200

set -euo pipefail

: "${AXL_PEERS:?AXL_PEERS is required (comma-separated tls:// urls)}"

export AGENT_ABBR="${AGENT_ABBR:-observer}"
ABBR_LC="$(echo "$AGENT_ABBR" | tr '[:upper:]' '[:lower:]')"

export AXL_LISTEN_PORT="${AXL_LISTEN_PORT:-9001}"
export AXL_API_PORT="${AXL_API_PORT:-9002}"
export AXL_TCP_PORT="${AXL_TCP_PORT:-7000}"
export MCP_ROUTER_PORT="${MCP_ROUTER_PORT:-9003}"
# Observer doesn't expose A2A, but the AXL config schema still wants the
# field — set it to a sentinel high port that nothing binds to.
export A2A_SERVER_PORT="${A2A_SERVER_PORT:-9999}"

# Observer-specific
export OBSERVER_PORT="${OBSERVER_PORT:-3001}"
export OBSERVER_MCP_PORT="${OBSERVER_MCP_PORT:-7200}"
export AXL_API_URL="http://127.0.0.1:${AXL_API_PORT}"
export MCP_ROUTER_URL="http://127.0.0.1:${MCP_ROUTER_PORT}"

KEY_DIR="/app/.keys"
KEY_PATH="${KEY_DIR}/node-${ABBR_LC}.pem"
mkdir -p "$KEY_DIR"

if [[ -f "/run/secrets/axl_key" ]]; then
  cp /run/secrets/axl_key "$KEY_PATH"
elif [[ ! -f "$KEY_PATH" ]]; then
  echo "[observer] generating fresh ed25519 key at $KEY_PATH"
  openssl genpkey -algorithm ed25519 -out "$KEY_PATH" >/dev/null 2>&1
fi
chmod 600 "$KEY_PATH"

# Build peers JSON
peers_json="["
IFS=',' read -ra peer_arr <<<"$AXL_PEERS"
for i in "${!peer_arr[@]}"; do
  peer="${peer_arr[$i]}"
  peer="${peer# }"; peer="${peer% }"
  if [[ $i -gt 0 ]]; then peers_json+=","; fi
  peers_json+="\"${peer}\""
done
peers_json+="]"
export AXL_PEERS_JSON="$peers_json"
export AXL_KEY_PATH="$KEY_PATH"

CONFIG_PATH="/app/mesh/configs/node-${ABBR_LC}.json"
mkdir -p "$(dirname "$CONFIG_PATH")"
envsubst < /app/docker/configs/node.template.json > "$CONFIG_PATH"
echo "[observer] AXL config: $CONFIG_PATH"
cat "$CONFIG_PATH"

PIDS=()
shutdown() {
  echo "[observer] shutting down…"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# Step 1: AXL node
echo "[observer] starting AXL node on api :${AXL_API_PORT}"
cd /app/mesh/configs
axl-node -config "node-${ABBR_LC}.json" &
PIDS+=($!)
cd /app
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${AXL_API_PORT}/topology" >/dev/null 2>&1; then
    echo "[observer] AXL ready"
    break
  fi
  if [[ $i -eq 30 ]]; then echo "[observer] AXL FAILED"; exit 1; fi
  sleep 0.5
done

# Step 2: MCP router
echo "[observer] starting MCP router on :${MCP_ROUTER_PORT}"
python -m mcp_routing.mcp_router --port "$MCP_ROUTER_PORT" &
PIDS+=($!)
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${MCP_ROUTER_PORT}/health" >/dev/null 2>&1; then
    echo "[observer] MCP router ready"
    break
  fi
  if [[ $i -eq 30 ]]; then echo "[observer] MCP router FAILED"; exit 1; fi
  sleep 0.5
done

# Step 3: Observer Bun process (foreground)
echo "[observer] starting Bun observer on http :${OBSERVER_PORT} mcp :${OBSERVER_MCP_PORT}"
cd /app/packages/observer
exec bun run src/index.ts
