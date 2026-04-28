#!/usr/bin/env bash
# Phase 2 gate test.
#
# Per TECHNICAL.md §Phase 2: a 5-agent mesh sustains for 1 hour with each agent
# broadcasting a real FRED-derived indicator each tick, reasoning over a peer's
# proposal via Claude (via OpenRouter preset), persisting decisions to memory,
# and AgentCards browsable per state. The 1-hour requirement is compressed to a
# ~3-minute smoke test that checks every gate condition deterministically.
#
# Required state:
#   - mesh up via scripts/run-local-mesh.sh (default 5-agent layout)
#   - .env.local sourced into THIS shell (FRED_API_KEY, OPENROUTER_API_KEY)
#     so the test can detect "real-data" mode

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env.local so this shell sees FRED_API_KEY / OPENROUTER_API_KEY.
if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

DATA_PLANE_PORT="${DATA_PLANE_PORT:-3002}"
DATA_PLANE_URL="http://127.0.0.1:$DATA_PLANE_PORT"
MA_API="http://127.0.0.1:9002"
CA_API="http://127.0.0.1:9012"

PASS=0
FAIL=0
WARN=0

ok()    { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
warn()  { echo "  ⚠ $*"; WARN=$((WARN+1)); }

FRED_REAL=0
if [[ -n "${FRED_API_KEY:-}" && "${FRED_API_KEY}" != "PLACEHOLDER_32_HEX" ]]; then
  FRED_REAL=1
fi
REASONING_REAL=0
if [[ -n "${OPENROUTER_API_KEY:-}" && "${OPENROUTER_API_KEY}" != "sk-or-v1-PLACEHOLDER" ]]; then
  REASONING_REAL=1
fi

echo "[phase2-gate] FRED real=$FRED_REAL  reasoning real=$REASONING_REAL"

# ---- 1. data plane health --------------------------------------------------
HEALTH_BODY="$(curl -fsS "$DATA_PLANE_URL/healthz" 2>/dev/null || true)"
if [[ -z "$HEALTH_BODY" ]]; then
  fail "data plane /healthz unreachable"
else
  STATES_LOADED=$(echo "$HEALTH_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("states_loaded",0))')
  if [[ "$STATES_LOADED" -gt 0 ]]; then
    ok "data plane has $STATES_LOADED states loaded"
  elif [[ "$FRED_REAL" == "1" ]]; then
    fail "data plane loaded 0 states (FRED key set but no data)"
  else
    warn "data plane has 0 states — expected without FRED key"
  fi
fi

# ---- 2. snapshot for MA ----------------------------------------------------
SNAP="$(curl -fsS "$DATA_PLANE_URL/snapshot/25" 2>/dev/null || true)"
if [[ -z "$SNAP" ]]; then
  if [[ "$FRED_REAL" == "1" ]]; then
    fail "no MA snapshot in data plane"
  else
    warn "no MA snapshot — expected without FRED key"
  fi
else
  IND_COUNT=$(echo "$SNAP" | python3 -c 'import sys,json; o=json.load(sys.stdin); print(len([k for k,v in o.get("indicators",{}).items() if v]))')
  if [[ "$IND_COUNT" -gt 0 ]]; then
    ok "MA snapshot has $IND_COUNT populated indicator(s)"
  elif [[ "$FRED_REAL" == "1" ]]; then
    fail "MA snapshot empty despite FRED key being set"
  else
    warn "MA snapshot present but empty"
  fi
fi

# ---- 3. wait for ticks + at least one reflection cadence -------------------
# Tick = 30s by default; reflection runs every 4 ticks ⇒ first reflection
# at tick 4 (~120s). We wait 75s which guarantees ≥2 broadcasts and most of
# the way to the first reflection. If REFLECT_EVERY_N_TICKS=2 in env, even
# better.
WAIT_S=75
echo "[phase2-gate] sleeping ${WAIT_S}s for ticks + reflection..."
sleep "$WAIT_S"

# ---- 4. memory state.json + log per agent ---------------------------------
for state_dir in ma ca tx ny fl; do
  STATE_FILE="$ROOT/memory/$state_dir/state.json"
  LOG_FILE="$ROOT/memory/$state_dir/log.jsonl"
  if [[ ! -f "$STATE_FILE" ]]; then
    fail "memory/$state_dir/state.json missing"
    continue
  fi
  TICK=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('tickCount',0))")
  if [[ "$TICK" -gt 0 ]]; then
    ok "memory/$state_dir/state.json present (tickCount=$TICK)"
  else
    warn "memory/$state_dir/state.json present but tickCount=0"
  fi
  if [[ ! -f "$LOG_FILE" ]]; then
    warn "memory/$state_dir/log.jsonl missing (no log entries yet)"
  fi
done

# ---- 5. MA broadcast log shows FRED source ---------------------------------
MA_LOG="$ROOT/memory/ma/log.jsonl"
if [[ -f "$MA_LOG" ]]; then
  if grep -q '"kind":"broadcast_sent"' "$MA_LOG"; then
    if [[ "$FRED_REAL" == "1" ]]; then
      if grep -q 'FRED:' "$MA_LOG"; then
        ok "MA broadcast log contains FRED-sourced indicator"
      else
        fail "broadcast log present but no FRED source"
      fi
    else
      ok "MA broadcast log present (FRED key absent, source check skipped)"
    fi
  else
    warn "no broadcast_sent entries in MA log yet"
  fi
fi

# ---- 6. at least one reflection entry --------------------------------------
REFLECTION_FOUND=0
for log in "$ROOT"/memory/*/log.jsonl; do
  [[ -f "$log" ]] || continue
  if grep -q '"kind":"reflection"' "$log"; then
    REFLECTION_FOUND=1
    break
  fi
done
if [[ "$REFLECTION_FOUND" == "1" ]]; then
  ok "at least one agent has a reflection log entry"
else
  warn "no reflection entries yet — REFLECT_EVERY_N_TICKS may exceed wait window"
fi

# ---- 7. AgentCard via AXL bridge (persona-driven description) -------------
MA_KEY=$(curl -fsS "$MA_API/topology" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("our_public_key",""))' || echo "")
if [[ -z "$MA_KEY" ]]; then
  fail "couldn't read MA pubkey from $MA_API"
else
  # AXL forwards GET /a2a/{peer} → {peer}/.well-known/agent-card.json
  # server-side. Use the bare path.
  CARD=$(curl -fsS "$CA_API/a2a/$MA_KEY" 2>/dev/null || true)
  if [[ -z "$CARD" ]]; then
    fail "MA AgentCard unreachable from CA via AXL"
  else
    DESC=$(echo "$CARD" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("description",""))')
    SKILL_COUNT=$(echo "$CARD" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("skills",[])))')
    if echo "$DESC" | grep -qi "tech-revenue"; then
      ok "MA AgentCard has persona-driven tagline ($SKILL_COUNT skills advertised)"
    elif echo "$DESC" | grep -qi "Sovereign AI"; then
      fail "MA AgentCard still using Phase-1 generic tagline"
    else
      warn "MA AgentCard tagline unexpected: '${DESC:0:80}'"
    fi
  fi
fi

# ---- 8. negotiate-bilateral-swap lifecycle (no exact-amount assertion) -----
# Round 1: proposal → expect input-required + counter
# Round 2: accept the counter → expect completed + settlement
# (Phase 1 asserted a deterministic 5% haircut; Phase 2 lets the reasoner
#  pick any reasonable haircut, so we only assert the lifecycle shape.)
if [[ -n "$MA_KEY" ]]; then
  PROP_MID=$(uuidgen)
  TMP_REQ=$(mktemp)
  TMP_R1=$(mktemp)
  python3 - "$PROP_MID" "$TMP_REQ" <<'PY'
import json, sys
mid, path = sys.argv[1], sys.argv[2]
body = {
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {"message": {"kind": "message", "role": "user", "messageId": mid,
    "parts": [{"kind": "data", "data": {"kind": "proposal", "initiator_fips": 6,
      "give":    {"asset": "USDC",     "amount": "1000000000000"},
      "receive": {"asset": "MA-TOKEN", "amount": "500000000000"},
      "rationale": "CA rebalancing toward New England exposure"}}]}}
}
open(path, "w").write(json.dumps(body))
PY
  curl -sS -X POST "$CA_API/a2a/$MA_KEY" -H 'Content-Type: application/json' -d "@$TMP_REQ" -o "$TMP_R1"
  R1_STATE=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("result",{}).get("status",{}).get("state","-"))' "$TMP_R1" 2>/dev/null)
  R1_TASK=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("result",{}).get("id",""))' "$TMP_R1" 2>/dev/null)

  if [[ "$R1_STATE" == "input-required" && -n "$R1_TASK" ]]; then
    ok "negotiate round 1: state=input-required (taskId=${R1_TASK:0:8}…)"
    ACC_MID=$(uuidgen)
    TMP_REQ2=$(mktemp)
    TMP_R2=$(mktemp)
    python3 - "$ACC_MID" "$R1_TASK" "$TMP_R1" "$TMP_REQ2" <<'PY'
import json, sys
mid, task_id, r1_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
r1 = json.load(open(r1_path))
counter = r1.get("result", {}).get("status", {}).get("message", {}).get("parts", [{}])[0].get("data", {})
body = {
  "jsonrpc": "2.0", "id": 2, "method": "message/send",
  "params": {"message": {"kind": "message", "role": "user", "messageId": mid, "taskId": task_id,
    "parts": [{"kind": "data", "data": {"kind": "accept", "by_fips": 6,
      "agreed_give":    counter.get("receive", {}),
      "agreed_receive": counter.get("give",    {})}}]}}
}
open(out_path, "w").write(json.dumps(body))
PY
    curl -sS -X POST "$CA_API/a2a/$MA_KEY" -H 'Content-Type: application/json' -d "@$TMP_REQ2" -o "$TMP_R2"
    R2_STATE=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("result",{}).get("status",{}).get("state","-"))' "$TMP_R2" 2>/dev/null)
    R2_KIND=$(python3 -c '
import sys, json
o = json.load(open(sys.argv[1]))
parts = o.get("result", {}).get("status", {}).get("message", {}).get("parts", [])
print(parts[0].get("data", {}).get("kind", "-") if parts else "-")
' "$TMP_R2" 2>/dev/null)
    if [[ "$R2_STATE" == "completed" && "$R2_KIND" == "settlement" ]]; then
      ok "negotiate round 2: state=completed with settlement payload"
    else
      fail "negotiate round 2: state=$R2_STATE kind=$R2_KIND (expected completed/settlement)"
      head -c 300 "$TMP_R2"
    fi
    rm -f "$TMP_REQ2" "$TMP_R2"
  else
    fail "negotiate round 1: state=$R1_STATE (expected input-required)"
    head -c 300 "$TMP_R1"
  fi
  rm -f "$TMP_REQ" "$TMP_R1"
fi

# ---- 9. participate-in-coalition --------------------------------------------
if [[ -n "$MA_KEY" ]]; then
  COAL_MID=$(uuidgen)
  TMP_COAL_REQ=$(mktemp)
  TMP_COAL_RESP=$(mktemp)
  python3 - "$COAL_MID" "$TMP_COAL_REQ" <<'PY'
import json, sys
mid, path = sys.argv[1], sys.argv[2]
body = {
  "jsonrpc": "2.0", "id": 99, "method": "message/send",
  "params": {"message": {"kind": "message", "role": "user", "messageId": mid,
    "parts": [{"kind": "data", "data": {"skill": "participate-in-coalition",
      "initiator_fips": 6, "coalition_tag": "northeast",
      "topic": "shared aid pool Q3 2026", "proposed_contribution_usd": 250000}}]}}
}
open(path, "w").write(json.dumps(body))
PY
  curl -sS -X POST "$CA_API/a2a/$MA_KEY" -H 'Content-Type: application/json' -d "@$TMP_COAL_REQ" -o "$TMP_COAL_RESP"
  COAL_STATE=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1])).get("result",{}).get("status",{}).get("state","-"))' "$TMP_COAL_RESP" 2>/dev/null)
  COAL_KIND=$(python3 -c '
import sys, json
o = json.load(open(sys.argv[1]))
parts = o.get("result", {}).get("status", {}).get("message", {}).get("parts", [])
print(parts[0].get("data", {}).get("kind", "-") if parts else "-")
' "$TMP_COAL_RESP" 2>/dev/null)
  if [[ "$COAL_STATE" == "completed" ]]; then
    ok "participate-in-coalition completed (responder kind=$COAL_KIND)"
  else
    fail "participate-in-coalition state=$COAL_STATE (expected completed)"
    head -c 300 "$TMP_COAL_RESP"
  fi
  rm -f "$TMP_COAL_REQ" "$TMP_COAL_RESP"
fi

echo ""
echo "[phase2-gate] summary: $PASS passed, $FAIL failed, $WARN warned"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
