#!/usr/bin/env bash
# Spike 06 — Deploy a minimal ERC-20 on Unichain Sepolia via Foundry.
#
# Proves: Unichain Sepolia RPC accepts contract deploys from our deployer
# wallet and we can read the resulting address back.
#
# Env required:
#   UNICHAIN_SEPOLIA_RPC             (default https://sepolia.unichain.org)
#   WALLET_DEPLOYER_PRIVATE_KEY      (must be funded — Sepolia faucet + bridge)
#
# Usage: ./spikes/06-unichain-erc20/run.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$ROOT/spikes/06-unichain-erc20"

if [[ -f "$ROOT/.env.local" ]]; then set -a; . "$ROOT/.env.local"; set +a; fi

if [[ -z "${UNICHAIN_SEPOLIA_RPC:-}" ]]; then
  echo "[spike-06] SKIP — UNICHAIN_SEPOLIA_RPC not set"; exit 0
fi

PK="${WALLET_DEPLOYER_PRIVATE_KEY:-}"
ADDR="${WALLET_DEPLOYER_ADDRESS:-}"
if [[ -z "$PK" || "$PK" == "0xPLACEHOLDER" ]]; then
  echo "[spike-06] SKIP — WALLET_DEPLOYER_PRIVATE_KEY not set (placeholder)."
  exit 0
fi

echo "[spike-06] checking deployer balance on Unichain Sepolia..."
BAL=$(cast balance "$ADDR" --rpc-url "$UNICHAIN_SEPOLIA_RPC" 2>&1 || echo "error")
echo "[spike-06]   $ADDR balance: $BAL wei"
if [[ "$BAL" == "0" || "$BAL" == "error" ]]; then
  echo "[spike-06] SKIP — deployer wallet $ADDR is empty on Unichain Sepolia."
  echo "  Get Sepolia ETH then bridge to Unichain Sepolia: https://www.alchemy.com/faucets/ethereum-sepolia"
  echo "  Then bridge via the Unichain bridge or use any Unichain Sepolia faucet."
  exit 0
fi

cd "$SPIKE_DIR"

echo "[spike-06] compiling..."
forge build --silent

echo "[spike-06] deploying HelloToken with initialSupply=1e24..."
DEPLOY_OUT=$(forge create \
  --rpc-url "$UNICHAIN_SEPOLIA_RPC" \
  --private-key "$PK" \
  src/HelloToken.sol:HelloToken \
  --constructor-args 1000000000000000000000000 \
  --broadcast \
  --json 2>&1)

echo "$DEPLOY_OUT"
ADDR_DEPLOYED=$(echo "$DEPLOY_OUT" | python3 -c 'import sys,json; print(json.loads([l for l in sys.stdin if l.strip().startswith("{")][0]).get("deployedTo",""))' 2>/dev/null || true)

if [[ -z "$ADDR_DEPLOYED" || "$ADDR_DEPLOYED" == "null" ]]; then
  echo "[spike-06] FAIL: could not parse deployedTo from forge output"
  exit 1
fi

echo ""
echo "[spike-06] PASS — deployed HelloToken to $ADDR_DEPLOYED"
echo "[spike-06] verify: https://unichain-sepolia.blockscout.com/address/$ADDR_DEPLOYED"

NAME=$(cast call "$ADDR_DEPLOYED" "name()(string)" --rpc-url "$UNICHAIN_SEPOLIA_RPC")
SUPPLY=$(cast call "$ADDR_DEPLOYED" "totalSupply()(uint256)" --rpc-url "$UNICHAIN_SEPOLIA_RPC")
echo "[spike-06]   name()        = $NAME"
echo "[spike-06]   totalSupply() = $SUPPLY"
