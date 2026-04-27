# Spike 04 — FRED API state-level series fetch

**Status:** ⏸ GATED on `FRED_API_KEY` (placeholder in `.env.local`)

## What it proves

A free FRED API key returns the latest observations for a state-level series
(`MAUR` = Massachusetts unemployment rate, monthly). This is the data backbone
that 8-10 deep state-agents will read every tick in Phase 2.

## Run

1. Sign up (free, instant) at https://fred.stlouisfed.org/docs/api/api_key.html
2. Replace `FRED_API_KEY=PLACEHOLDER_32_HEX` in `.env.local`.
3. `./spikes/04-fred-series/run.sh`

If the key is still a placeholder, the spike exits 0 with a SKIP message.

## Files

- [`fetch.ts`](./fetch.ts) — Bun script that GETs the FRED series endpoint.
- [`run.sh`](./run.sh) — loads `.env.local`, runs `fetch.ts`.

## Useful series IDs (for reference, used in later phases)

| FIPS | State | Unemployment | GDP |
|---|---|---|---|
| 25 | MA | `MAUR` | `MANGSP` |
| 06 | CA | `CAUR` | `CANGSP` |
| 48 | TX | `TXUR` | `TXNGSP` |
| 36 | NY | `NYUR` | `NYNGSP` |
| 12 | FL | `FLUR` | `FLNGSP` |
| 17 | IL | `ILUR` | `ILNGSP` |
| 53 | WA | `WAUR` | `WANGSP` |
| 02 | AK | `AKUR` | `AKNGSP` |
