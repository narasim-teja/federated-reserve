# Spike 08 — 0G Storage upload + download round-trip

**Status:** ⏸ GATED on funded `WALLET_DEPLOYER_ADDRESS` on 0G Galileo testnet

## What it proves

The `@0gfoundation/0g-storage-ts-sdk` is wired correctly, the indexer URL
is reachable, and our deployer wallet can pay the on-chain anchor for a
small JSON blob. Phase 5 builds on this for encrypted-memory iNFTs.

## Run

1. Fund `WALLET_DEPLOYER_ADDRESS` at https://faucet.0g.ai (0.1 0G/day).
2. `./spikes/08-0g-storage/run.sh`

The script uploads `{ "hello": "0G", "ts": <iso> }`, prints the root hash
and tx hash, then downloads by root hash and asserts the bytes round-trip.
On success, prints the storagescan URL for the root hash.

If the deployer wallet is unfunded, the spike exits 0 with a SKIP message.
