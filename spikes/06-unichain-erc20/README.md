# Spike 06 — Deploy hello-world ERC-20 on Unichain Sepolia

**Status:** ⏸ GATED on funded `WALLET_DEPLOYER_ADDRESS` on Unichain Sepolia

## What it proves

The Unichain Sepolia RPC accepts contract deploys from our deployer wallet
and the resulting address is readable. Phase 3 replaces this with the real
per-state `StateToken` contracts.

## Run

1. Get Sepolia ETH (e.g. https://www.alchemy.com/faucets/ethereum-sepolia)
   for `WALLET_DEPLOYER_ADDRESS`.
2. Bridge to Unichain Sepolia via the Unichain bridge or a direct faucet.
3. `./spikes/06-unichain-erc20/run.sh`.

If unfunded, the spike exits 0 with a SKIP message + funding instructions.

## Files

- [`foundry.toml`](./foundry.toml) — minimal config, RPC from env.
- [`src/HelloToken.sol`](./src/HelloToken.sol) — minimal ERC-20.
- [`run.sh`](./run.sh) — checks balance, compiles, deploys, verifies via
  `cast call name()` and `totalSupply()`.
