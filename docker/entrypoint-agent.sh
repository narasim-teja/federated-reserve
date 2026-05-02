#!/usr/bin/env bash
# Federated Reserve agent — container entrypoint.
#
# Boots, in order: AXL node → Python MCP router → Bun agent. The first two
# run in the background; the agent runs in the foreground so the container
# lifecycle tracks it. SIGTERM shuts everything down cleanly.
#
# Required env (passed in by docker-compose / ECS task definition):
#   AGENT_ABBR        e.g. "ma" — used for paths/keys, lowercased
#   STATE_FIPS        e.g. "25"
#   AXL_PEERS         comma-separated tls:// peer URLs (other agents in mesh)
#   WALLET_<ABBR>_PRIVATE_KEY / _ADDRESS  per-agent wallet
#   OPENROUTER_API_KEY, FRED_API_KEY, ... (shared)
#
# Optional env:
#   AXL_LISTEN_PORT   default 9001
#   AXL_API_PORT      default 9002
#   AXL_TCP_PORT      default 7000
#   MCP_ROUTER_PORT   default 9003
#   A2A_SERVER_PORT   default 9004
#   MCP_SERVER_PORT   default 7100
#   MEMORY_BACKEND    default "og" (set to "local" to disable 0G round-trip)
#   OG_ANCHOR_ENABLED default 1 (set to 0 to skip iNFT updateMetadata calls)

set -euo pipefail

: "${AGENT_ABBR:?AGENT_ABBR is required}"
: "${STATE_FIPS:?STATE_FIPS is required}"
: "${AXL_PEERS:?AXL_PEERS is required (comma-separated tls:// urls)}"

ABBR_LC="$(echo "$AGENT_ABBR" | tr '[:upper:]' '[:lower:]')"

# ---------- Defaults ---------------------------------------------------------
export AXL_LISTEN_PORT="${AXL_LISTEN_PORT:-9001}"
export AXL_API_PORT="${AXL_API_PORT:-9002}"
export AXL_TCP_PORT="${AXL_TCP_PORT:-7000}"
export MCP_ROUTER_PORT="${MCP_ROUTER_PORT:-9003}"
export A2A_SERVER_PORT="${A2A_SERVER_PORT:-9004}"
export MCP_SERVER_PORT="${MCP_SERVER_PORT:-7100}"
export MEMORY_BACKEND="${MEMORY_BACKEND:-og}"
export OG_ANCHOR_ENABLED="${OG_ANCHOR_ENABLED:-1}"
export MEMORY_ROOT="${MEMORY_ROOT:-/app/memory}"

# Derived URLs the agent reads.
export AXL_API_URL="http://127.0.0.1:${AXL_API_PORT}"
export MCP_ROUTER_URL="http://127.0.0.1:${MCP_ROUTER_PORT}"

# ---------- Materialise per-agent files -------------------------------------
KEY_DIR="/app/.keys"
KEY_PATH="${KEY_DIR}/node-${ABBR_LC}.pem"
mkdir -p "$KEY_DIR" "$MEMORY_ROOT/${ABBR_LC}"

# ed25519 key. If a secret is mounted at /run/secrets/axl_key it wins;
# otherwise we generate a fresh one (peers will see this agent as new).
if [[ -f "/run/secrets/axl_key" ]]; then
  cp /run/secrets/axl_key "$KEY_PATH"
elif [[ ! -f "$KEY_PATH" ]]; then
  echo "[entrypoint $ABBR_LC] generating fresh ed25519 key at $KEY_PATH"
  openssl genpkey -algorithm ed25519 -out "$KEY_PATH" >/dev/null 2>&1
fi
chmod 600 "$KEY_PATH"

# 0G iNFT symmetric key — required when MEMORY_BACKEND=og uses the iNFT
# encrypted-blob path. If a secret is mounted at /run/secrets/og_key, copy
# it. Without it, OgStorageMemory falls back to plaintext blobs (still
# functional, just unencrypted).
if [[ -f "/run/secrets/og_key" ]]; then
  cp /run/secrets/og_key "$MEMORY_ROOT/${ABBR_LC}/og-key.bin"
  chmod 600 "$MEMORY_ROOT/${ABBR_LC}/og-key.bin"
fi

# ---------- Generate AXL config ---------------------------------------------
# Build the JSON peers array from the comma-separated AXL_PEERS env.
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
echo "[entrypoint $ABBR_LC] AXL config: $CONFIG_PATH"
cat "$CONFIG_PATH"

# ---------- Process supervision ---------------------------------------------
PIDS=()
shutdown() {
  echo "[entrypoint $ABBR_LC] shutting down…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# ---------- Step 1: AXL node -------------------------------------------------
echo "[entrypoint $ABBR_LC] starting AXL node on api :${AXL_API_PORT} listen :${AXL_LISTEN_PORT}"
cd /app/mesh/configs
axl-node -config "node-${ABBR_LC}.json" &
PIDS+=($!)
cd /app

for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${AXL_API_PORT}/topology" >/dev/null 2>&1; then
    echo "[entrypoint $ABBR_LC] AXL ready (attempt $i)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "[entrypoint $ABBR_LC] AXL FAILED to come up"
    exit 1
  fi
  sleep 0.5
done

# ---------- Step 2: Python MCP router sidecar -------------------------------
echo "[entrypoint $ABBR_LC] starting MCP router on :${MCP_ROUTER_PORT}"
python -m mcp_routing.mcp_router --port "$MCP_ROUTER_PORT" &
PIDS+=($!)
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${MCP_ROUTER_PORT}/health" >/dev/null 2>&1; then
    echo "[entrypoint $ABBR_LC] MCP router ready (attempt $i)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "[entrypoint $ABBR_LC] MCP router FAILED to come up"
    exit 1
  fi
  sleep 0.5
done

# ---------- Step 3: Bun agent (foreground) ----------------------------------
echo "[entrypoint $ABBR_LC] starting agent (FIPS=${STATE_FIPS}, memory=${MEMORY_BACKEND})"
cd /app/packages/agent
exec bun run src/index.ts
