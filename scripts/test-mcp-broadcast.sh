#!/usr/bin/env bash
# Phase 1 test 2: app-level broadcast of `share_economic_indicator`.
#
# AXL has no native pubsub — broadcasts are O(N) MCP fan-outs over
# `/mcp/{peer}/treasurer`. Test:
#   1. CA fan-outs an indicator to MA and TX (via its own /topology)
#   2. Verify MA's and TX's logs contain the receipt line
#
# Assumes ./scripts/run-local-mesh.sh is up; reads its log dir from
# $LOG_DIR or /tmp/federated-reserve.

set -euo pipefail

LOG_DIR="${LOG_DIR:-/tmp/federated-reserve}"

MA_API=http://127.0.0.1:9002
CA_API=http://127.0.0.1:9012
TX_API=http://127.0.0.1:9022

MA_KEY=$(curl -s "$MA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
TX_KEY=$(curl -s "$TX_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')

# Gather CA's discovered peer set via its own share_topology MCP tool.
# This exercises the production-grade discovery path (1-hop gossip over
# MCP) — no hub-side cheating. Wait up to 30s for gossip to converge.
CA_KEY=$(curl -s "$CA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
TOPO_REQ='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"share_topology","arguments":{}}}'

PEER_KEYS=""
DEADLINE=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  RESP=$(curl -sS -X POST "$MA_API/mcp/$CA_KEY/treasurer" \
    -H "Content-Type: application/json" -d "$TOPO_REQ" 2>/dev/null || echo "")
  if [[ -n "$RESP" ]]; then
    INNER=$(echo "$RESP" | python3 -c '
import json,sys
try:
  o=json.load(sys.stdin)
  text=o.get("result",{}).get("content",[{}])[0].get("text","")
  print(text)
except Exception:
  print("")
')
    if [[ -n "$INNER" ]]; then
      CANDIDATE=$(echo "$INNER" | python3 -c '
import json,sys
try:
  o=json.load(sys.stdin)
  print(" ".join(o.get("peers", [])))
except Exception:
  pass
')
      n=$(echo "$CANDIDATE" | wc -w | tr -d ' ')
      if [[ "$n" -ge 2 ]]; then
        PEER_KEYS="$CANDIDATE"
        break
      fi
    fi
  fi
  sleep 2
done

if [[ -z "$PEER_KEYS" ]]; then
  echo "[test-broadcast] ✗ CA's discovery never converged to ≥2 peers within 30s"
  exit 1
fi
echo "[test-broadcast] CA discovered $(echo "$PEER_KEYS" | wc -w | tr -d ' ') peer(s) via gossip"

# Marker so we can grep the logs deterministically — random per run.
MARKER="phase1-bcast-$(date +%s)-$RANDOM"
TS=$(python3 -c 'import datetime;print(datetime.datetime.utcnow().isoformat()+"Z")')

INDICATOR_BODY=$(python3 -c "
import json
print(json.dumps({
  'jsonrpc':'2.0',
  'id': 99,
  'method':'tools/call',
  'params':{
    'name':'share_economic_indicator',
    'arguments':{
      'state_fips': 6,
      'indicator': 'unemployment',
      'value': 4.321,
      'timestamp': '$TS',
      'source': '$MARKER'
    }
  }
}))
")

echo "[test-broadcast] CA fan-out share_economic_indicator (source=$MARKER) to:"
ok=0
total=0
for k in $PEER_KEYS; do
  total=$((total+1))
  CODE=$(curl -sS -X POST "$CA_API/mcp/$k/treasurer" \
    -H "Content-Type: application/json" \
    -d "$INDICATOR_BODY" -o /tmp/test-bcast.body -w '%{http_code}' || echo "000")
  if [[ "$CODE" == "200" ]]; then
    echo "    ✓ ${k:0:12}…  HTTP 200"
    ok=$((ok+1))
  else
    echo "    ✗ ${k:0:12}…  HTTP $CODE  $(cat /tmp/test-bcast.body | head -c 200)"
  fi
done
echo "[test-broadcast] $ok/$total fan-outs returned 200"

if [[ "$ok" -lt "$total" ]] || [[ "$total" -lt 2 ]]; then
  echo "[test-broadcast] ✗ expected ≥2 successful fan-outs"
  exit 1
fi

# Now verify MA and TX logged the receipt.
sleep 1
fail=0
for who in MA TX; do
  log="$LOG_DIR/agent-$who.log"
  if grep -q "$MARKER" "$log"; then
    line=$(grep "$MARKER" "$log" | tail -1)
    echo "[test-broadcast]   $who log: $line"
  else
    echo "[test-broadcast] ✗ $who agent log missing marker $MARKER"
    fail=$((fail+1))
  fi
done

if [[ $fail -gt 0 ]]; then
  echo "[test-broadcast] ✗ $fail receivers missing the indicator"
  exit 1
fi

echo "[test-broadcast] ✓ both peers (MA, TX) recorded the indicator"
