# FEEDBACK.md

---

- **`docs-gap:` (testnet support claim vs. reality)** — The official
  supported-chains page (https://api-docs.uniswap.org/guides/supported_chains)
  lists Unichain Sepolia (1301), Base Sepolia (84532), and Ethereum
  Sepolia (11155111) as supported. But probing chain 1301 with mainnet
  USDC/WETH addresses returns
  `404 {"errorCode":"ResourceNotFound","detail":"No quotes available"}`.
  This is _correct behavior_ (those addresses don't exist on testnet) —
  but the error is identical to the one you'd get on a genuinely
  unsupported chain. A more helpful response would distinguish "chain
  unsupported" (e.g. 400 with `errorCode: ChainNotSupported`) from
  "no liquidity for this pair" (the current 404). When you're trying to
  validate testnet integration before deploying contracts, this
  ambiguity costs an hour of debugging.

- **`docs-gap:` (`routingPreference` schema mismatch with skill docs)** —
  The Uniswap-published `swap-integration` SKILL.md
  (`packages/plugins/uniswap-trading/skills/swap-integration/SKILL.md`,
  v1.3.0) lists three values for `routingPreference`: `BEST_PRICE`,
  `FASTEST`, and `CLASSIC`. Sending `"routingPreference": "CLASSIC"`
  with `"protocols": ["V3"]` returns
  `400 {"errorCode":"RequestValidationError","detail":"\"routingPreference\" must be one of [BEST_PRICE, FASTEST]"}`.
  Either the skill needs to drop CLASSIC from the enum, or the API
  needs to accept it. Workaround: omit `routingPreference` entirely;
  the API still returns CLASSIC routing for V3-only pools, since
  there's nothing else to route through on a fresh testnet.

- **`bug:` (Trading API CLASSIC `swap.gasLimit` is occasionally too
  tight for the inner pool ERC-20 transfer)** — On Unichain Sepolia
  chain 1301, our second swap from a freshly-Permit2-approved wallet
  came back with a `gasLimit` low enough that the V3 pool's inner
  `safeTransfer` to the recipient hit `OutOfGas` and reverted with
  Uniswap's "TF" error. cast trace:
  `pool.swap(...) → ERC20.transfer(recipient, ...) ↘ [OutOfGas]
  → revert "TF"`. Smoke-test of the same `/swap` calldata pattern
  worked because that call had a higher returned `gasLimit`; the
  responder-side swap fired ~5s later got a tighter estimate. Two
  observations: (1) the API estimate doesn't add headroom for the
  recipient-side transfer when the recipient is a contract or has
  unusual code, and (2) the SwapRouter shell shouldn't return success
  for the outer call frame when the inner `transfer` ran out of gas —
  it does, leaving us a "succeeded" return value with status 0 in
  the receipt. Workaround: ignore `swap.gasLimit`, run
  `eth_estimateGas` ourselves, add a 25% headroom, then send.
  Suggested fix: bake recipient-aware buffer into the API's quoted
  gasLimit (or surface a separate `gasLimitMin`/`gasLimitRecommended`
  pair). Real cost: ~0.001 ETH wasted, plus an hour of debugging
  before reading the trace.

- **`gotcha:` (RPC stale-read after `createAndInitializePoolIfNecessary`
  bricks a same-block follow-up `mint`)** — Unichain Sepolia's public
  RPC (`https://sepolia.unichain.org`) takes 1-3s to propagate writes.
  We seeded 5 V3 pools with the standard pattern
  (`createAndInitializePoolIfNecessary` → `mint` in sequence). 2 of 5
  succeeded; 3 reverted with the pool's `slot0.sqrtPriceX96` reading
  zero from the same RPC node that just confirmed the init. Pattern
  was non-deterministic across runs (different states succeeded each
  attempt). Workaround: poll `slot0` until non-zero before issuing the
  mint, or insert a 2-3s sleep. Better long-term fix: NPM should
  expose a `createInitMintAndBurn` style multicall that bundles all
  three ops in one tx, eliminating the cross-tx visibility race. Not
  strictly a Uniswap bug — it's a Unichain RPC consistency issue —
  but anyone copying the V3 LP recipe verbatim will hit it on testnet.
