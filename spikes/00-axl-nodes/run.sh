#!/usr/bin/env bash
# Spike 00 — run two AXL nodes locally, verify peering + send/recv round-trip.
#
# What it proves:
#   1. AXL node binary builds and starts
#   2. Two nodes can peer over local TLS (no external bootstrap needed)
#   3. /topology returns each node's public key
#   4. POST /send + GET /recv round-trips a message
#
# Usage:
#   ./spikes/00-axl-nodes/run.sh            # run the spike
#   ./spikes/00-axl-nodes/run.sh stop       # kill any leftover node processes

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$ROOT/vendor/axl/node"
CONFIG_DIR="$ROOT/spikes/00-axl-nodes/configs"
PID_FILE="/tmp/federated-reserve-spike-00.pids"

cmd="${1:-run}"

cleanup() {
  echo "[spike-00] stopping nodes..."
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # Belt-and-suspenders: kill anything on the spike ports
  for port in 9001 9002 9012 7000 7001; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

if [[ "$cmd" == "stop" ]]; then
  cleanup
  echo "[spike-00] stopped."
  exit 0
fi

trap cleanup EXIT

[[ -x "$NODE_BIN" ]] || { echo "ERROR: AXL node binary missing at $NODE_BIN — run 'make build' in vendor/axl"; exit 1; }
[[ -f "$ROOT/.keys/node-a.pem" ]] || { echo "ERROR: .keys/node-a.pem missing"; exit 1; }
[[ -f "$ROOT/.keys/node-b.pem" ]] || { echo "ERROR: .keys/node-b.pem missing"; exit 1; }

cleanup  # clear any stragglers
sleep 1

mkdir -p /tmp
> "$PID_FILE"

echo "[spike-00] starting node A (api :9002, listen :9001)..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-a.json > /tmp/spike-00-node-a.log 2>&1 ) &
echo $! >> "$PID_FILE"

# Give A a moment to start listening before B tries to dial.
sleep 2

echo "[spike-00] starting node B (api :9012, peers -> :9001)..."
( cd "$CONFIG_DIR" && "$NODE_BIN" -config node-b.json > /tmp/spike-00-node-b.log 2>&1 ) &
echo $! >> "$PID_FILE"

# Wait for both APIs to come up
echo "[spike-00] waiting for both APIs..."
for url in http://127.0.0.1:9002/topology http://127.0.0.1:9012/topology; do
  for i in {1..15}; do
    if curl -fsS "$url" > /dev/null 2>&1; then
      echo "  - $url ✓"
      break
    fi
    if [[ $i -eq 15 ]]; then
      echo "  - $url ✗ (timeout)"
      echo "--- node A log ---"; tail -30 /tmp/spike-00-node-a.log
      echo "--- node B log ---"; tail -30 /tmp/spike-00-node-b.log
      exit 1
    fi
    sleep 1
  done
done

# Give Yggdrasil a moment to actually peer + gVisor TCP listeners to be ready
sleep 6

NODE_A_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')
NODE_B_KEY=$(curl -s http://127.0.0.1:9012/topology | python3 -c 'import sys,json; print(json.load(sys.stdin)["our_public_key"])')

echo ""
echo "[spike-00] node A public key: $NODE_A_KEY"
echo "[spike-00] node B public key: $NODE_B_KEY"
echo ""

A_PEERS=$(curl -s http://127.0.0.1:9002/topology | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("peers",[])))')
B_PEERS=$(curl -s http://127.0.0.1:9012/topology | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("peers",[])))')
echo "[spike-00] node A sees $A_PEERS peer(s)"
echo "[spike-00] node B sees $B_PEERS peer(s)"

if [[ "$A_PEERS" -lt 1 || "$B_PEERS" -lt 1 ]]; then
  echo "[spike-00] FAIL: nodes did not peer with each other"
  echo "--- topology A ---"; curl -s http://127.0.0.1:9002/topology | python3 -m json.tool
  echo "--- topology B ---"; curl -s http://127.0.0.1:9012/topology | python3 -m json.tool
  exit 1
fi

# Send fire-and-forget message B -> A. Retry a few times if gVisor TCP isn't
# ready immediately after Yggdrasil TLS comes up.
MSG="hello from node B at $(date -u +%FT%TZ)"
echo "[spike-00] sending: '$MSG' from B to A..."
SEND_RESP=""
for attempt in {1..8}; do
  RESP_CODE=$(curl -sS -X POST http://127.0.0.1:9012/send \
    -H "X-Destination-Peer-Id: $NODE_A_KEY" \
    -d "$MSG" -o /tmp/spike-00-send.body -w '%{http_code}' || echo "000")
  echo "  attempt $attempt: HTTP $RESP_CODE  body=$(cat /tmp/spike-00-send.body 2>/dev/null | head -c 200)"
  if [[ "$RESP_CODE" == "200" ]]; then
    SEND_RESP="$RESP_CODE"
    break
  fi
  sleep 2
done

if [[ "$SEND_RESP" != "200" ]]; then
  echo "[spike-00] FAIL: /send never returned 200"
  echo "--- node A log tail ---"; tail -40 /tmp/spike-00-node-a.log
  echo "--- node B log tail ---"; tail -40 /tmp/spike-00-node-b.log
  exit 1
fi

# Poll /recv on A for up to 10s
echo "[spike-00] polling A's /recv ..."
RECV=""
for i in {1..20}; do
  RESP=$(curl -sS -o /tmp/spike-00-recv.body -w '%{http_code}' http://127.0.0.1:9002/recv)
  if [[ "$RESP" == "200" ]]; then
    RECV=$(cat /tmp/spike-00-recv.body)
    break
  fi
  sleep 0.5
done

if [[ -z "$RECV" ]]; then
  echo "[spike-00] FAIL: no message received in 10s"
  echo "--- node A log tail ---"; tail -40 /tmp/spike-00-node-a.log
  echo "--- node B log tail ---"; tail -40 /tmp/spike-00-node-b.log
  exit 1
fi

if [[ "$RECV" == "$MSG" ]]; then
  echo "[spike-00] PASS — round-trip received: '$RECV'"
else
  echo "[spike-00] FAIL — got: '$RECV' expected: '$MSG'"
  exit 1
fi

echo ""
echo "[spike-00] all checks passed. logs at /tmp/spike-00-node-{a,b}.log"
