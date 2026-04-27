#!/usr/bin/env bash
# Spike 03 — Uniswap Trading API quote round-trip.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$ROOT/spikes/03-uniswap-quote"

if [[ -f "$ROOT/.env.local" ]]; then set -a; . "$ROOT/.env.local"; set +a; fi

[[ -d "$SPIKE_DIR/node_modules" ]] || (cd "$SPIKE_DIR" && bun install >/dev/null 2>&1)

cd "$SPIKE_DIR" && bun run quote.ts
