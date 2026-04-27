#!/usr/bin/env bash
# Spike 04 — FRED API state-level series fetch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$ROOT/spikes/04-fred-series"
if [[ -f "$ROOT/.env.local" ]]; then set -a; . "$ROOT/.env.local"; set +a; fi
cd "$SPIKE_DIR" && bun run fetch.ts
