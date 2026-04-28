/**
 * Spike 03 — Uniswap Trading API /v1/quote round-trip.
 *
 * Proves: with a Developer Platform API key, the Uniswap Trading API returns
 * a structured quote we can use to build calldata in Phase 3.
 *
 * Run: bun run spikes/03-uniswap-quote/quote.ts
 *
 * Env required:
 *   UNISWAP_API_KEY                 (Uniswap Developer Platform key)
 *   WALLET_DEPLOYER_ADDRESS         (any funded address — used as `swapper`)
 *   UNICHAIN_SEPOLIA_CHAIN_ID       (default 1301)
 *
 * The actual /v1/quote endpoint is a POST with a JSON body. Mainnet defaults
 * are used here since Unichain Sepolia tokens may not have routes — Phase 3
 * will run this on Sepolia with seeded pools.
 */

const API_KEY = process.env.UNISWAP_API_KEY;
const SWAPPER = process.env.WALLET_DEPLOYER_ADDRESS;

if (!API_KEY || API_KEY === 'PLACEHOLDER_UNISWAP_DEV_PORTAL_KEY') {
  console.error('[spike-03] SKIP — UNISWAP_API_KEY not set (placeholder).');
  console.error('  Get one at https://developers.uniswap.org/ and put it in .env.local');
  process.exit(0);
}
if (!SWAPPER || SWAPPER === '0xPLACEHOLDER') {
  console.error('[spike-03] SKIP — WALLET_DEPLOYER_ADDRESS not set.');
  process.exit(0);
}

// Mainnet USDC -> WETH for connectivity test (smallest, most-liquid path)
const body = {
  tokenIn: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC (mainnet)
  tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH (mainnet)
  amount: '1000000', // 1 USDC (6 decimals)
  type: 'EXACT_INPUT',
  tokenInChainId: 1,
  tokenOutChainId: 1,
  swapper: SWAPPER,
};

const url = 'https://trade-api.gateway.uniswap.org/v1/quote';
console.log(`[spike-03] POST ${url}`);
console.log(`[spike-03] body: ${JSON.stringify(body)}`);

const t0 = performance.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
  },
  body: JSON.stringify(body),
});
const ms = (performance.now() - t0).toFixed(0);

const text = await res.text();
console.log(`[spike-03] HTTP ${res.status} in ${ms}ms`);

if (!res.ok) {
  console.error(`[spike-03] FAIL: ${text.slice(0, 500)}`);
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(`[spike-03] FAIL: response is not JSON: ${text.slice(0, 500)}`);
  process.exit(1);
}

const obj = parsed as Record<string, unknown>;
if (!obj.quote && !obj.routing) {
  console.error(
    `[spike-03] FAIL: response missing 'quote' or 'routing' field: ${text.slice(0, 500)}`,
  );
  process.exit(1);
}

console.log('[spike-03] PASS — Uniswap Trading API responded with quote');
console.log('[spike-03] preview:');
console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
