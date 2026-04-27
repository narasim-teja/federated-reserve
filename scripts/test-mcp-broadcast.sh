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

# Gather peer pubkeys from the hub (MA), which sees the full mesh, then drop
# our own (CA's) pubkey so we fan out to *other* states. The Yggdrasil
# spanning tree at non-hub nodes lags during early lifetime — production
# discovery needs an MCP `share_topology` gossip tool (Phase 2 task) — but
# the underlying routing works fine, as the unicast test already proves.
CA_KEY=$(curl -s "$CA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
PEER_KEYS=$(curl -s "$MA_API/topology" | python3 -c "
import sys,json
o=json.load(sys.stdin)
mine='$CA_KEY'
seen=set()
for src in (o.get('tree') or []):
  k=src.get('public_key')
  if k and k!=mine and k!=o['our_public_key']: seen.add(k)
for src in (o.get('peers') or []):
  k=src.get('public_key')
  if k and k!=mine and k!=o['our_public_key']: seen.add(k)
# include MA itself (we want CA → {MA, TX})
seen.add(o['our_public_key'])
print(' '.join(seen))
")

if [[ -z "$PEER_KEYS" ]]; then
  echo "[test-broadcast] ✗ CA has no peers"
  exit 1
fi

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
