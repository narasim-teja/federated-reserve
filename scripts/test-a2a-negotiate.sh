#!/usr/bin/env bash
# Phase 1 test 3: A2A multi-turn negotiate-bilateral-swap lifecycle.
#
# CA (initiator) opens a bilateral swap with MA (responder). Phase 1 used a
# deterministic 5% counter; Phase 2+ is OpenRouter-driven, so this test checks
# the lifecycle shape and a parseable counter without hard-coding the amount.
#
#   round 1: CA sends `proposal`         → MA returns Task(input-required)
#                                           with a `counter` Message
#   round 2: CA sends `accept` (re-using
#            the taskId from round 1)    → MA returns Task(completed)
#                                           with a `settlement` Message
#
# Verifies:
#   - round-1 task.status.state == 'input-required'
#   - round-1 status.message contains a counter DataPart
#   - round-2 task.status.state == 'completed'
#   - round-2 status.message contains a settlement DataPart with rounds≥2
#
# Assumes ./scripts/run-local-mesh.sh is up.

set -euo pipefail

CA_API=http://127.0.0.1:9012
MA_API=http://127.0.0.1:9002

MA_KEY=$(curl -s "$MA_API/topology" | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_public_key"])')

PROPOSAL_MID=$(uuidgen)

ROUND1=$(python3 -c "
import json
print(json.dumps({
  'jsonrpc':'2.0',
  'id': 1,
  'method':'message/send',
  'params':{
    'message':{
      'kind':'message',
      'role':'user',
      'messageId':'$PROPOSAL_MID',
      'parts':[{
        'kind':'data',
        'data':{
          'kind':'proposal',
          'initiator_fips': 6,
          'give':   {'asset':'USDC','amount':'1000000000000'},
          'receive':{'asset':'MA-TOKEN','amount':'500000000000'},
          'rationale':'CA rebalancing toward New England exposure'
        }
      }]
    }
  }
}))
")

echo "[test-a2a] round 1: CA → MA proposal"
R1=""
for attempt in {1..6}; do
  CODE=$(curl -sS -X POST "$CA_API/a2a/$MA_KEY" \
    -H "Content-Type: application/json" \
    -d "$ROUND1" -o /tmp/test-a2a-r1.body -w '%{http_code}' || echo "000")
  body=$(cat /tmp/test-a2a-r1.body)
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$body" | head -c 160)"
  if [[ "$CODE" == "200" ]]; then R1="$body"; break; fi
  sleep 2
done

if [[ -z "$R1" ]]; then
  echo "[test-a2a] ✗ round 1 never got HTTP 200"
  exit 1
fi

# Parse: result.id (taskId), result.status.state, result.status.message.parts[0].data
read -r STATE TASK_ID COUNTER_KIND COUNTER_GIVE_AMT <<<"$(echo "$R1" | python3 -c '
import json,sys
o=json.load(sys.stdin)
res=o.get("result",{})
state=res.get("status",{}).get("state","")
tid=res.get("id","")
msg=res.get("status",{}).get("message",{})
parts=msg.get("parts",[]) if msg else []
data=parts[0].get("data",{}) if parts else {}
kind=data.get("kind","-")
amt=data.get("give",{}).get("amount","-")
print(state, tid, kind, amt)
')"

echo "[test-a2a]   round 1: state=$STATE  task=$TASK_ID  counter.kind=$COUNTER_KIND  counter.give.amount=$COUNTER_GIVE_AMT"

if [[ "$STATE" != "input-required" ]]; then
  echo "[test-a2a] ✗ expected state=input-required, got $STATE"
  echo "$R1" | python3 -m json.tool
  exit 1
fi
if [[ "$COUNTER_KIND" != "counter" ]]; then
  echo "[test-a2a] ✗ expected status.message DataPart kind=counter, got $COUNTER_KIND"
  exit 1
fi
if ! [[ "$COUNTER_GIVE_AMT" =~ ^[0-9]+$ ]] || [[ "$COUNTER_GIVE_AMT" == "0" ]]; then
  echo "[test-a2a] ✗ expected positive numeric counter.give.amount, got $COUNTER_GIVE_AMT"
  exit 1
fi

ACCEPT_MID=$(uuidgen)
ROUND2=$(python3 -c "
import json
print(json.dumps({
  'jsonrpc':'2.0',
  'id': 2,
  'method':'message/send',
  'params':{
    'message':{
      'kind':'message',
      'role':'user',
      'messageId':'$ACCEPT_MID',
      'taskId':'$TASK_ID',
      'parts':[{
        'kind':'data',
        'data':{
          'kind':'accept',
          'by_fips': 6,
          'agreed_give':   {'asset':'USDC','amount':'1000000000000'},
          'agreed_receive':{'asset':'MA-TOKEN','amount':'$COUNTER_GIVE_AMT'}
        }
      }]
    }
  }
}))
")

echo "[test-a2a] round 2: CA → MA accept (taskId=$TASK_ID)"
R2=""
for attempt in {1..3}; do
  CODE=$(curl -sS -X POST "$CA_API/a2a/$MA_KEY" \
    -H "Content-Type: application/json" \
    -d "$ROUND2" -o /tmp/test-a2a-r2.body -w '%{http_code}' || echo "000")
  body=$(cat /tmp/test-a2a-r2.body)
  echo "  attempt $attempt: HTTP $CODE  body=$(echo "$body" | head -c 160)"
  if [[ "$CODE" == "200" ]]; then R2="$body"; break; fi
  sleep 2
done

if [[ -z "$R2" ]]; then
  echo "[test-a2a] ✗ round 2 never got HTTP 200"
  exit 1
fi

read -r STATE2 SETTLE_KIND SETTLE_ROUNDS <<<"$(echo "$R2" | python3 -c '
import json,sys
o=json.load(sys.stdin)
res=o.get("result",{})
state=res.get("status",{}).get("state","")
msg=res.get("status",{}).get("message",{})
parts=msg.get("parts",[]) if msg else []
data=parts[0].get("data",{}) if parts else {}
kind=data.get("kind","-")
rounds=data.get("rounds",-1)
print(state, kind, rounds)
')"

echo "[test-a2a]   round 2: state=$STATE2  settlement.kind=$SETTLE_KIND  rounds=$SETTLE_ROUNDS"

if [[ "$STATE2" != "completed" ]]; then
  echo "[test-a2a] ✗ expected state=completed, got $STATE2"
  echo "$R2" | python3 -m json.tool
  exit 1
fi
if [[ "$SETTLE_KIND" != "settlement" ]]; then
  echo "[test-a2a] ✗ expected status.message DataPart kind=settlement, got $SETTLE_KIND"
  exit 1
fi
if [[ "$SETTLE_ROUNDS" -lt 2 ]]; then
  echo "[test-a2a] ✗ expected rounds≥2, got $SETTLE_ROUNDS"
  exit 1
fi

echo "[test-a2a] ✓ Working → InputRequired → Completed lifecycle round-tripped"
