# Spike 05 — Deploy hello-world ERC-721 on 0G Chain testnet

**Status:** ⏸ GATED on funded `WALLET_DEPLOYER_ADDRESS` on 0G testnet

## What it proves

The 0G EVM testnet RPC accepts contract deploys from our deployer wallet
and the resulting address is readable. Phase 5 replaces this with the real
ERC-7857 iNFT contract.

## Run

1. Visit https://faucet.0g.ai and request testnet tokens for
   `WALLET_DEPLOYER_ADDRESS` (look it up in `.env.local`).
2. Once funded, `./spikes/05-0g-erc721/run.sh`.

If unfunded, the spike exits 0 with a SKIP message + funding instructions.

## Files

- [`foundry.toml`](./foundry.toml) — minimal config, RPC from env.
- [`src/HelloNFT.sol`](./src/HelloNFT.sol) — minimal ERC-721-shaped contract.
- [`run.sh`](./run.sh) — checks balance, compiles, deploys, verifies via
  `cast call name()`.
