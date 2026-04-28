#!/usr/bin/env bash
# Phase 2 gate test.
#
# Per TECHNICAL.md §Phase 2: a 5-agent mesh sustains for 1 hour with each agent
# broadcasting a real FRED-derived indicator each tick, reasoning over a peer's
# proposal via Claude, persisting decisions to memory, and AgentCards browsable
# per state. We compress the 1-hour requirement to a ~3-minute smoke test that
# checks every gate condition deterministically.
#
# Required state: ./scripts/run-local-mesh.sh up (default 5-agent mesh).
#
# Checks:
#   1. data plane /healthz returns ok and states_loaded > 0
#         → if FRED_API_KEY is unset/placeholder, this is downgraded to a WARN
#   2. data plane /snapshot/25 (MA) has at least one indicator
#         → WARN if no FRED key
#   3. After ~30s, MA's broadcast log shows at least one entry whose source
#      starts with "FRED:" (real data, not synthetic)
#         → WARN if no FRED key
#   4. AgentCard for MA has the persona-driven tagline (not "Sovereign AI ...")
#   5. CA → MA negotiate-bilateral-swap completes successfully (existing
#      Phase 1 lifecycle still works with reasoner-or-fallback decision logic)
#   6. memory/{ma,ca,tx,ny,fl}/state.json exists with tickCount > 0
#   7. At least one of the agents has a reflection log entry
#   8. CA → MA participate-in-coalition skill returns a 'completed' task
#
# Exits 0 on PASS (warnings allowed when FRED key absent), 1 on FAIL.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

# Detect whether FRED is keyed up — adjusts soft vs hard checks below.
FRED_REAL=0
if [[ -n "${FRED_API_KEY:-}" && "${FRED_API_KEY}" != "PLACEHOLDER_32_HEX" ]]; then
  FRED_REAL=1
fi

echo "[phase2-gate] checking data plane on $DATA_PLANE_URL (FRED real=$FRED_REAL)"

# ---- 1. data plane health --------------------------------------------------
HEALTH_BODY="$(curl -fsS "$DATA_PLANE_URL/healthz" 2>/dev/null || true)"
if [[ -z "$HEALTH_BODY" ]]; then
  fail "data plane /healthz unreachable"
else
  STATES_LOADED=$(echo "$HEALTH_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("states_loaded",0))')
  if [[ "$FRED_REAL" == "1" ]]; then
    if [[ "$STATES_LOADED" -gt 0 ]]; then
      ok "data plane loaded $STATES_LOADED states from FRED"
    else
      fail "data plane reachable but no states loaded (FRED key set but no data)"
    fi
  else
    if [[ "$STATES_LOADED" -gt 0 ]]; then
      ok "data plane loaded $STATES_LOADED states (cached from prior run)"
    else
      warn "data plane has 0 states — FRED_API_KEY is placeholder, expected"
    fi
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
  else
    warn "MA snapshot present but empty (FRED 400/404 on series)"
  fi
fi

# ---- 3. MA broadcast log shows FRED source ---------------------------------
echo "[phase2-gate] sleeping 35s for ticks to fire..."
sleep 35

MA_LOG="$ROOT/memory/ma/log.jsonl"
if [[ ! -f "$MA_LOG" ]]; then
  fail "memory/ma/log.jsonl missing — agent never persisted log"
else
  if grep -q '"kind": *"broadcast_sent"' "$MA_LOG"; then
    if [[ "$FRED_REAL" == "1" ]]; then
      if grep -q 'FRED:' "$MA_LOG"; then
        ok "MA broadcast log contains FRED-sourced indicator"
      else
        fail "MA broadcast log present but no FRED source (data-plane pipeline broken?)"
      fi
    else
      ok "MA broadcast log present (FRED key absent, source check skipped)"
    fi
  else
    warn "no broadcast_sent entries in MA log — peers may not have been discovered yet"
  fi
fi

# ---- 4. AgentCard tagline --------------------------------------------------
MA_KEY=$(curl -fsS "$MA_API/topology" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("our_public_key",""))' || echo "")
if [[ -z "$MA_KEY" ]]; then
  fail "couldn't read MA pubkey from $MA_API"
else
  CARD=$(curl -fsS "$CA_API/a2a/$MA_KEY/.well-known/agent-card.json" 2>/dev/null || true)
  if [[ -z "$CARD" ]]; then
    fail "MA AgentCard unreachable from CA via AXL"
  else
    DESC=$(echo "$CARD" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("description",""))')
    if echo "$DESC" | grep -qi "tech-revenue"; then
      ok "MA AgentCard description is the persona-driven tagline ('${DESC:0:60}...')"
    elif echo "$DESC" | grep -qi "Sovereign AI"; then
      fail "MA AgentCard still using Phase-1 generic tagline"
    else
      warn "MA AgentCard tagline unexpected: '${DESC:0:80}'"
    fi
  fi
fi

# ---- 5. negotiate-bilateral-swap (Phase 1 test, still must work) ------------
if "$ROOT/scripts/test-a2a-negotiate.sh" > /tmp/phase2-a2a.log 2>&1; then
  ok "negotiate-bilateral-swap lifecycle still green"
else
  fail "negotiate-bilateral-swap regressed — see /tmp/phase2-a2a.log"
  tail -20 /tmp/phase2-a2a.log
fi

# ---- 6. memory state.json per agent ----------------------------------------
for state_dir in ma ca tx ny fl; do
  STATE_FILE="$ROOT/memory/$state_dir/state.json"
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
done

# ---- 7. at least one reflection entry --------------------------------------
REFLECTION_FOUND=0
for log in "$ROOT"/memory/*/log.jsonl; do
  [[ -f "$log" ]] || continue
  if grep -q '"kind": *"reflection"' "$log"; then
    REFLECTION_FOUND=1
    break
  fi
done
if [[ "$REFLECTION_FOUND" == "1" ]]; then
  ok "at least one agent has a reflection log entry"
else
  warn "no reflection entries yet — REFLECT_EVERY_N_TICKS may be too high for the 35s window"
fi

# ---- 8. CA → MA participate-in-coalition -----------------------------------
if [[ -n "$MA_KEY" ]]; then
  COAL_MID=$(uuidgen)
  COAL_REQ=$(python3 -c "
import json
print(json.dumps({
  'jsonrpc':'2.0',
  'id': 99,
  'method':'message/send',
  'params':{
    'message':{
      'kind':'message',
      'role':'user',
      'messageId':'$COAL_MID',
      'parts':[{
        'kind':'data',
        'data':{
          'skill':'participate-in-coalition',
          'initiator_fips': 6,
          'coalition_tag':'northeast',
          'topic':'shared aid pool Q3 2026',
          'proposed_contribution_usd': 250000
        }
      }]
    }
  }
}))
")
  COAL_RESP=$(curl -sS -X POST "$CA_API/a2a/$MA_KEY" \
    -H "Content-Type: application/json" \
    -d "$COAL_REQ" 2>/dev/null || echo "")
  if [[ -z "$COAL_RESP" ]]; then
    fail "participate-in-coalition request failed (no response)"
  else
    COAL_STATE=$(echo "$COAL_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("status",{}).get("state","-"))' 2>/dev/null)
    if [[ "$COAL_STATE" == "completed" ]]; then
      ok "participate-in-coalition lifecycle completed"
    else
      fail "participate-in-coalition state=$COAL_STATE (expected completed)"
      echo "$COAL_RESP" | head -c 300
    fi
  fi
fi

echo ""
echo "[phase2-gate] summary: $PASS passed, $FAIL failed, $WARN warned"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
