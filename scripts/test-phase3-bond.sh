#!/usr/bin/env bash
# Phase 3 bond-auction gate test — drives a primary-issuance settlement
# (MA bids → NY awards + mints → MA pays) and verifies real onchain balances.
#
# Assumes ./scripts/run-local-mesh.sh is up (5-agent mesh).
# Assumes scripts/deploy-contracts.ts and scripts/deploy-bond.ts have run.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/scripts/test-phase3-bond.ts" "$@"
