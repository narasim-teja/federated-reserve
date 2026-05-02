#!/usr/bin/env bash
# Spike 05 — Deploy a minimal ERC-721-shaped contract on 0G Chain testnet.
#
# Proves: the 0G EVM testnet RPC accepts contract deploys from our deployer
# wallet, and we can read the resulting address back.
#
# Env required:
#   OG_RPC_URL                       (default https://evmrpc-testnet.0g.ai)
#   WALLET_DEPLOYER_PRIVATE_KEY      (must be funded — faucet at https://faucet.0g.ai)
#
# Usage: ./spikes/05-0g-erc721/run.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$ROOT/spikes/05-0g-erc721"

if [[ -f "$ROOT/.env.local" ]]; then set -a; . "$ROOT/.env.local"; set +a; fi

if [[ -z "${OG_RPC_URL:-}" ]]; then
  echo "[spike-05] SKIP — OG_RPC_URL not set"
  exit 0
fi

PK="${WALLET_DEPLOYER_PRIVATE_KEY:-}"
ADDR="${WALLET_DEPLOYER_ADDRESS:-}"
if [[ -z "$PK" || "$PK" == "0xPLACEHOLDER" ]]; then
  echo "[spike-05] SKIP — WALLET_DEPLOYER_PRIVATE_KEY not set (placeholder)."
  echo "  Run scripts/derive-wallets.sh after setting MASTER_SEED to populate."
  exit 0
fi

# Check balance first; fail fast with a useful message if unfunded
echo "[spike-05] checking deployer balance on 0G..."
BAL=$(cast balance "$ADDR" --rpc-url "$OG_RPC_URL" 2>&1 || echo "error")
echo "[spike-05]   $ADDR balance: $BAL wei"
if [[ "$BAL" == "0" || "$BAL" == "error" ]]; then
  echo "[spike-05] SKIP — deployer wallet $ADDR is empty on 0G testnet."
  echo "  Faucet: https://faucet.0g.ai (paste the address above, request testnet tokens, retry)"
  exit 0
fi

cd "$SPIKE_DIR"

echo "[spike-05] compiling..."
forge build --silent

echo "[spike-05] deploying HelloNFT..."
DEPLOY_OUT=$(forge create \
  --rpc-url "$OG_RPC_URL" \
  --private-key "$PK" \
  src/HelloNFT.sol:HelloNFT \
  --broadcast \
  --json 2>&1)

echo "$DEPLOY_OUT"
# forge --json now emits the JSON over multiple lines; collect the full block, then parse.
ADDR_DEPLOYED=$(echo "$DEPLOY_OUT" \
  | python3 -c 'import sys,json,re; t=sys.stdin.read(); m=re.search(r"\{[^{}]*\"deployedTo\"[^{}]*\}", t, re.S); print(json.loads(m.group(0))["deployedTo"] if m else "")' 2>/dev/null || true)

if [[ -z "$ADDR_DEPLOYED" || "$ADDR_DEPLOYED" == "null" ]]; then
  echo "[spike-05] FAIL: could not parse deployedTo from forge output"
  exit 1
fi

echo ""
echo "[spike-05] PASS — deployed HelloNFT to $ADDR_DEPLOYED"
echo "[spike-05] verify on 0G explorer: https://chainscan-galileo.0g.ai/address/$ADDR_DEPLOYED"

# Round-trip read: call name() to confirm code is present
NAME=$(cast call "$ADDR_DEPLOYED" "name()(string)" --rpc-url "$OG_RPC_URL")
echo "[spike-05]   name() = $NAME"
