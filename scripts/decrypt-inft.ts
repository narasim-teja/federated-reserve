/**
 * Phase 5 — proof of embedded intelligence.
 *
 * Given an iNFT (token id), reads on-chain `encryptedURI` + `sealedKey`,
 * downloads the encrypted bundle from 0G Storage, unseals the symmetric
 * key with the *recipient's* secp256k1 private key, decrypts the bundle,
 * verifies the keccak-256 commitment matches `metadataHash`, and prints
 * a summary of the agent that was just reconstructed from chain + storage.
 *
 * This is what the 0G iNFT submission needs to demonstrate: ownership of
 * the token alone is sufficient to recover the agent's persistent memory.
 *
 * Usage:
 *   bun run scripts/decrypt-inft.ts MA           # uses WALLET_MA_PRIVATE_KEY
 *   bun run scripts/decrypt-inft.ts MA 0xABC...  # explicit recipient PK
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import {
  bundleFromBytes,
  decryptBundle,
  INFTContract,
  OgStorage,
  rootHashFromUri,
  unsealSymmetricKey,
} from '../packages/og-inft/src/index.ts';
import { STATES } from '../packages/shared/src/states.ts';
import type { Address, Hex } from 'viem';

const REPO_ROOT = join(import.meta.dir, '..');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'contracts', 'deployments', '0g-galileo.json');

function loadEnv(): void {
  if (!existsSync(ENV_LOCAL)) return;
  for (const raw of readFileSync(ENV_LOCAL, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('0xPLACEHOLDER') || v === 'PLACEHOLDER') throw new Error(`missing env: ${name}`);
  return v;
}

const RPC = need('OG_RPC_URL');
const INDEXER = need('OG_INDEXER_RPC');
const CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const EXPLORER = process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai';
const DEPLOYER_PK = need('WALLET_DEPLOYER_PRIVATE_KEY') as Hex;

const args = process.argv.slice(2);
const abbr = (args[0] ?? '').toUpperCase();
if (!abbr) {
  console.error('usage: bun run scripts/decrypt-inft.ts <STATE_ABBR> [recipientPrivateKey]');
  process.exit(2);
}
const stateDef = STATES.find((s) => s.abbr === abbr);
if (!stateDef) {
  console.error(`unknown state: ${abbr}`);
  process.exit(2);
}
const recipientPkRaw = args[1] ?? process.env[`WALLET_${abbr}_PRIVATE_KEY`];
if (!recipientPkRaw || recipientPkRaw === '0xPLACEHOLDER') {
  console.error(`no recipient PK: pass it as arg 2 or set WALLET_${abbr}_PRIVATE_KEY`);
  process.exit(2);
}
const recipientPkBytes = Buffer.from(recipientPkRaw.replace(/^0x/, ''), 'hex');

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const inftAddress = deployments.contracts.INFT7857.address as Address;

const inft = new INFTContract({
  rpcUrl: RPC,
  chainId: CHAIN_ID,
  privateKey: DEPLOYER_PK, // for read-only ops; not used to sign here
  inftAddress,
  explorerBase: EXPLORER,
});
const storage = new OgStorage({ rpcUrl: RPC, indexerUrl: INDEXER, privateKey: DEPLOYER_PK });

const tokenId = BigInt(stateDef.fips);
console.log(`[decrypt-inft] inft=${inftAddress} tokenId=${tokenId} (${abbr})`);

// 1. Read on-chain state.
const onChainOwner = await inft.ownerOf(tokenId);
const encryptedURI = await inft.encryptedURI(tokenId);
const expectedHash = await inft.metadataHash(tokenId);
const sealedHex = await inft.sealedKey(tokenId);
console.log(`[decrypt-inft]   owner          = ${onChainOwner}`);
console.log(`[decrypt-inft]   encryptedURI   = ${encryptedURI}`);
console.log(`[decrypt-inft]   metadataHash   = ${expectedHash}`);
console.log(`[decrypt-inft]   sealedKey      = ${sealedHex.slice(0, 18)}... (${(sealedHex.length - 2) / 2} B)`);

// 2. Download encrypted blob from 0G Storage.
const rootHash = rootHashFromUri(encryptedURI);
console.log(`[decrypt-inft] downloading 0G blob ${rootHash}...`);
const blob = await storage.download(rootHash);
console.log(`[decrypt-inft]   downloaded ${blob.length} bytes`);

// 3. Unseal symmetric key with recipient PK + decrypt bundle.
const sealed = Buffer.from(sealedHex.slice(2), 'hex');
const symmetricKey = unsealSymmetricKey(new Uint8Array(sealed), recipientPkBytes);
const plaintext = decryptBundle(blob, symmetricKey);

// 4. Verify keccak-256 of the plaintext matches the on-chain commitment.
const computedHash = keccak256(plaintext);
if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
  console.error('[decrypt-inft] FAIL: metadataHash mismatch — bundle has been tampered with!');
  console.error(`  expected: ${expectedHash}`);
  console.error(`  computed: ${computedHash}`);
  process.exit(1);
}
console.log(`[decrypt-inft]   metadataHash verified (keccak256 matches on-chain commitment)`);

// 5. Hydrate the agent.
const bundle = bundleFromBytes(plaintext);
const memState = bundle.memory_state as Record<string, unknown>;
const persona = bundle.persona as Record<string, unknown>;
const log = bundle.recent_log;

console.log('');
console.log(`=== ${abbr} agent reconstructed from iNFT ${tokenId} ===`);
console.log(`  state            : ${bundle.state_name} (FIPS ${bundle.state_fips})`);
console.log(`  persona tagline  : ${persona.tagline ?? '<unset>'}`);
console.log(`  bundle generated : ${bundle.generated_at}`);
console.log(`  memory keys      : ${Object.keys(memState).slice(0, 10).join(', ')}`);
const tickCount = (memState as { tickCount?: number }).tickCount;
console.log(`  tickCount        : ${tickCount ?? 'n/a'}`);
console.log(`  recent_log       : ${log.length} entries`);
if (log.length > 0) {
  console.log(`  last log line    : ${JSON.stringify(log[log.length - 1]).slice(0, 160)}`);
}

// 6. Persist a small "proof bundle" the demo video can reference.
const outDir = join(REPO_ROOT, '.data', 'inft-proofs');
mkdirSync(outDir, { recursive: true });
const proofPath = join(outDir, `${abbr.toLowerCase()}.json`);
writeFileSync(
  proofPath,
  `${JSON.stringify(
    {
      state_abbr: abbr,
      token_id: tokenId.toString(),
      inft_contract: inftAddress,
      explorer: `${EXPLORER}/address/${inftAddress}`,
      owner: onChainOwner,
      encrypted_uri: encryptedURI,
      metadata_hash_onchain: expectedHash,
      metadata_hash_recomputed: computedHash,
      bundle_bytes: plaintext.length,
      blob_bytes: blob.length,
      decrypted_at: new Date().toISOString(),
      bundle_summary: {
        state_name: bundle.state_name,
        state_fips: bundle.state_fips,
        tickCount,
        log_entries: log.length,
        memory_keys: Object.keys(memState),
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`[decrypt-inft] PASS — wrote proof bundle to ${proofPath}`);
