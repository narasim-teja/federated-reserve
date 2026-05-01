#!/usr/bin/env bash
# Phase 5 gate — observer + dashboard data plane.
# Assumes the local mesh is running with INCLUDE_OBSERVER=1.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

bun "$ROOT/scripts/build-inft-manifest.ts"
exec bun "$ROOT/scripts/test-phase5-gate.ts" "$@"
