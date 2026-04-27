#!/usr/bin/env bash
# Phase 1 test 4: gossip-based mesh discovery converges.
#
# Each agent runs a discovery loop that periodically:
#   1. Reads its own /topology (peers + tree, dedup, exclude self)
#   2. For each known pubkey, MCP-calls share_topology and unions results
#
# After a few rounds, every agent's `share_topology` should report all
# (N-1) other peers — even non-hub agents whose /topology.tree initially
# under-reports indirect peers.
#
# We probe CA's view (the leaf node that originally suffered the lag):
# call MA → CA share_topology and assert the returned `peers` list contains
# both MA and TX.

set -euo pipefail

MA_API=http://127.0.0.1:9002
CA_API=http://127.0.0.1:9012
TX_API=http://127.0.0.1:9022

MA_KEY=$(curl -s "$MA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
CA_KEY=$(curl -s "$CA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
TX_KEY=$(curl -s "$TX_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')

REQ='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"share_topology","arguments":{}}}'

echo "[test-discovery] polling CA's discovery view (via MA → CA share_topology)…"
DEADLINE=$(( $(date +%s) + 60 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  RESP=$(curl -sS -X POST "$MA_API/mcp/$CA_KEY/treasurer" \
    -H "Content-Type: application/json" -d "$REQ" 2>/dev/null || echo "")
  if [[ -z "$RESP" ]]; then sleep 2; continue; fi

  INNER=$(echo "$RESP" | python3 -c '
import json,sys
o=json.load(sys.stdin)
text=o.get("result",{}).get("content",[{}])[0].get("text","")
print(text)
')
  if [[ -z "$INNER" ]]; then sleep 2; continue; fi

  CA_KNOWS=$(echo "$INNER" | python3 -c '
import json,sys
o=json.load(sys.stdin)
print(" ".join(o.get("peers", [])))
')
  REFRESHED=$(echo "$INNER" | python3 -c '
import json,sys
o=json.load(sys.stdin)
print(o.get("refreshed_at",""))
')

  count=0
  has_ma=0
  has_tx=0
  for k in $CA_KNOWS; do
    count=$((count+1))
    [[ "$k" == "$MA_KEY" ]] && has_ma=1
    [[ "$k" == "$TX_KEY" ]] && has_tx=1
  done

  echo "  CA refreshed_at=$REFRESHED  knows $count peer(s)  has_MA=$has_ma  has_TX=$has_tx"

  if [[ $has_ma -eq 1 && $has_tx -eq 1 ]]; then
    echo "[test-discovery] ✓ CA discovered both MA and TX via gossip"
    exit 0
  fi
  sleep 2
done

echo "[test-discovery] ✗ CA never discovered both peers within 60s"
exit 1
