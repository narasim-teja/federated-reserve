# Spike 03 — Uniswap Trading API quote round-trip

**Status:** ⏸ GATED on `UNISWAP_API_KEY` (placeholder in `.env.local`)

## What it proves

A `POST` to `https://trade-api.gateway.uniswap.org/v1/quote` with a valid
Developer Platform API key returns a structured quote. This is the wire we
will use in Phase 3 to actually execute swaps.

## Run

1. Sign up at https://developers.uniswap.org/ and grab an API key.
2. Replace `UNISWAP_API_KEY=PLACEHOLDER_UNISWAP_DEV_PORTAL_KEY` in `.env.local`.
3. `./spikes/03-uniswap-quote/run.sh`

If the key is still a placeholder, the spike exits 0 with a SKIP message.

## Files

- [`quote.ts`](./quote.ts) — Bun script that POSTs to `/v1/quote`.
- [`run.sh`](./run.sh) — loads `.env.local`, ensures deps, runs `quote.ts`.

## Why mainnet for the spike

Unichain Sepolia routes may be thin or empty until we seed our own pools in
Phase 3. The spike uses mainnet USDC→WETH purely for connectivity. Phase 3
will swap on Unichain Sepolia against pools we own.
