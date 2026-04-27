#!/usr/bin/env bash
# Phase 1 test 1: agent CA queries agent MA's `query_treasury` MCP tool.
#
# This is the spike-01 round-trip lifted into the Phase 1 mesh: peer B
# (CA) → AXL → peer A (MA) → MA's MCP Router → MA's TS MCP server.
#
# Assumes ./scripts/run-local-mesh.sh is up.

set -euo pipefail

MA_API=http://127.0.0.1:9002
CA_API=http://127.0.0.1:9012

MA_KEY=$(curl -s "$MA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')
CA_KEY=$(curl -s "$CA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')

echo "[test-unicast] CA (${CA_KEY:0:12}…) → MA (${MA_KEY:0:12}…) tools/call query_treasury"

REQ='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_treasury","arguments":{"state_fips":25}}}'

RESP=""
for attempt in {1..6}; do
  CODE=$(curl -sS -X POST "$CA_API/mcp/$MA_KEY/treasurer" \
    -H "Content-Type: application/json" \
    -d "$REQ" -o /tmp/test-unicast.body -w '%{http_code}' || echo "000")
  body=$(cat /tmp/test-unicast.body)
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$body" | head -c 160)"
  if [[ "$CODE" == "200" ]]; then RESP="$body"; break; fi
  sleep 2
done

if [[ -z "$RESP" ]]; then
  echo "[test-unicast] ✗ never got HTTP 200"
  exit 1
fi

# Inner result is JSON-stringified inside content[0].text per MCP spec.
INNER=$(echo "$RESP" | python3 -c '
import json,sys
o=json.load(sys.stdin)
text=o["result"]["content"][0]["text"]
print(text)
')

if echo "$INNER" | grep -qE '"state_abbr"\s*:\s*"MA"' && echo "$INNER" | grep -q reserve_ratio; then
  echo "[test-unicast] ✓ MA returned its treasury composition"
  echo "[test-unicast]   $(echo "$INNER" | head -c 200)…"
  exit 0
fi

echo "[test-unicast] ✗ unexpected result body: $INNER"
exit 1
