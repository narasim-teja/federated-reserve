#!/usr/bin/env bash
# Spike 08 — 0G Storage upload + download round-trip.
#
# Proves: @0gfoundation/0g-storage-ts-sdk is wired and our deployer wallet
# can anchor a small JSON blob on 0G Storage testnet via the turbo indexer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$ROOT/spikes/08-0g-storage"

if [[ -f "$ROOT/.env.local" ]]; then set -a; . "$ROOT/.env.local"; set +a; fi

if [[ -z "${OG_RPC_URL:-}" ]]; then
  echo "[spike-08] SKIP — OG_RPC_URL not set"; exit 0
fi
if [[ -z "${OG_INDEXER_RPC:-}" ]]; then
  echo "[spike-08] SKIP — OG_INDEXER_RPC not set (add it to .env.local)"; exit 0
fi
PK="${WALLET_DEPLOYER_PRIVATE_KEY:-}"
ADDR="${WALLET_DEPLOYER_ADDRESS:-}"
if [[ -z "$PK" || "$PK" == "0xPLACEHOLDER" ]]; then
  echo "[spike-08] SKIP — WALLET_DEPLOYER_PRIVATE_KEY not set"; exit 0
fi

# Quick balance precheck — uploading anchors a small tx, needs gas.
BAL=$(cast balance "$ADDR" --rpc-url "$OG_RPC_URL" 2>/dev/null || echo "0")
if [[ "$BAL" == "0" ]]; then
  echo "[spike-08] SKIP — deployer $ADDR is empty on 0G testnet."
  echo "  Faucet: https://faucet.0g.ai"
  exit 0
fi

cd "$SPIKE_DIR"
if [[ ! -d node_modules ]]; then
  echo "[spike-08] installing deps..."
  bun install --silent
fi

bun run smoke.ts
