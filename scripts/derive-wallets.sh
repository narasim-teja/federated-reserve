#!/usr/bin/env bash
# Re-derive the agent wallet hierarchy from $MASTER_SEED in .env.local
# Usage: ./scripts/derive-wallets.sh                # prints to stdout
#        ./scripts/derive-wallets.sh > /tmp/out     # capture
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load mnemonic
if [[ -f "$ROOT/.env.local" ]]; then
  # shellcheck source=/dev/null
  set -a; . "$ROOT/.env.local"; set +a
fi

if [[ -z "${MASTER_SEED:-}" ]]; then
  echo "ERROR: MASTER_SEED not set in .env.local" >&2
  exit 1
fi

# Index assignments must match TECHNICAL.md:
#   0   = master deployer / faucet
#   100 = Federal Reserve agent
#   101 = Treasury agent
#   N   = state agent at FIPS code N
declare -a AGENTS=(
  "0:DEPLOYER:Master deployer / faucet"
  "100:FED:Federal Reserve"
  "101:TREASURY:US Treasury"
  "25:MA:Massachusetts"
  "6:CA:California"
  "48:TX:Texas"
  "36:NY:New York"
  "12:FL:Florida"
  "17:IL:Illinois"
  "53:WA:Washington"
  "2:AK:Alaska"
)

for entry in "${AGENTS[@]}"; do
  IFS=':' read -r INDEX NAME DESC <<< "$entry"
  PK=$(cast wallet private-key "$MASTER_SEED" "$INDEX")
  ADDR=$(cast wallet address --private-key "$PK")
  echo "# $DESC (BIP-44 index $INDEX)"
  echo "WALLET_${NAME}_PRIVATE_KEY=${PK}"
  echo "WALLET_${NAME}_ADDRESS=${ADDR}"
  echo ""
done
