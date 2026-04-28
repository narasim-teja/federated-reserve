#!/usr/bin/env bash
# Phase 3 gate test — drives an end-to-end onchain settlement of an A2A
# bilateral swap, then verifies real balance changes on Unichain Sepolia.
#
# Assumes ./scripts/run-local-mesh.sh is up (5-agent mesh: MA/CA/TX/NY/FL).
# Assumes scripts/deploy-contracts.ts and scripts/seed-pools.ts have run.
#
# Body lives in scripts/test-phase3-gate.ts so it can use viem and the
# SwapExecutor module directly.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/scripts/test-phase3-gate.ts" "$@"
