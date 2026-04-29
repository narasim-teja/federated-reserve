#!/usr/bin/env bash
# Phase 4 gate test — federation scale-up + multi-bidder + aid + shock.
# Assumes ./scripts/run-local-mesh.sh is up (10-agent mesh) and Phase 4
# onchain deploys + IL bond have run.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/scripts/test-phase4-gate.ts" "$@"
