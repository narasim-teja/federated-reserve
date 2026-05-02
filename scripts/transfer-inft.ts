/**
 * Stop 6 — ERC-7857 transfer ceremony demo.
 *
 * Demonstrates that ownership of the on-chain token, plus the off-chain
 * re-encryption ceremony, transfers the agent's *intelligence* to a fresh
 * wallet that has never seen the original symmetric key.
 *
 *   1. Owner reads on-chain sealedKey, unseals with their private key,
 *      recovers the persistent symmetric key K.
 *   2. Generates a fresh ephemeral recipient secp256k1 keypair (saved
 *      under .data/inft-transfers/<abbr>.json).
 *   3. Re-seals K under the recipient's pubkey → newSealedKey.
 *   4. Builds proof = abi.encodePacked(currentMetadataHash). MockOracle
 *      pulls newHash directly from the proof and the contract rotates
 *      sealedKey, encryptedURI's hash, and ownership.
 *   5. Calls INFT7857.transfer(owner, recipient, tokenId, newSealedKey, proof).
 *   6. Verifies on-chain ownerOf == recipient.
 *   7. "Fresh owner" pass: download encrypted blob, unseal with the
 *      brand-new recipient PK, decrypt, hydrate agent — same persona,
 *      same memory, same tickCount as before transfer. Embedded
 *      intelligence verified.
 *
 * Usage:
 *   bun run scripts/transfer-inft.ts MA
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  bundleFromBytes,
  decryptBundle,
  generateSecpKeypair,
  INFTContract,
  loadAgentKey,
  OgStorage,
  rootHashFromUri,
  sealSymmetricKey,
  unsealSymmetricKey,
} from '../packages/og-inft/src/index.ts';
import { STATES } from '../packages/shared/src/states.ts';
import type { Address, Hex } from 'viem';

const REPO_ROOT = join(import.meta.dir, '..');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'contracts', 'deployments', '0g-galileo.json');
const TRANSFERS_DIR = join(REPO_ROOT, '.data', 'inft-transfers');

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

const abbr = (process.argv[2] ?? '').toUpperCase();
if (!abbr) {
  console.error('usage: bun run scripts/transfer-inft.ts <STATE_ABBR>');
  process.exit(2);
}
const stateDef = STATES.find((s) => s.abbr === abbr);
if (!stateDef) throw new Error(`unknown state ${abbr}`);

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const inftAddress = deployments.contracts.INFT7857.address as Address;
const tokenRecord = deployments.iNFTs?.[abbr];
if (!tokenRecord) throw new Error(`no iNFT minted for ${abbr}`);
const tokenId = BigInt(tokenRecord.tokenId);

const ownerPk = need(`WALLET_${abbr}_PRIVATE_KEY`) as Hex;
const ownerAddress = need(`WALLET_${abbr}_ADDRESS`) as Address;
const ownerPkBytes = Buffer.from(ownerPk.replace(/^0x/, ''), 'hex');

// Sign INFT7857.transfer with MA's funded wallet (msg.sender == from passes the contract check).
const inft = new INFTContract({
  rpcUrl: RPC,
  chainId: CHAIN_ID,
  privateKey: ownerPk,
  inftAddress,
  explorerBase: EXPLORER,
});
const storage = new OgStorage({ rpcUrl: RPC, indexerUrl: INDEXER, privateKey: ownerPk });

console.log(`[transfer-inft] iNFT ${tokenId} (${abbr}) currently owned by ${ownerAddress}`);

// ----- Step 1: read on-chain state ------------------------------------------
const onChainOwnerBefore = await inft.ownerOf(tokenId);
const sealedHexBefore = await inft.sealedKey(tokenId);
const encryptedURI = await inft.encryptedURI(tokenId);
const metadataHashBefore = await inft.metadataHash(tokenId);
console.log(`[transfer-inft]   sealedKey (before): ${sealedHexBefore.slice(0, 18)}...`);
console.log(`[transfer-inft]   encryptedURI:       ${encryptedURI}`);
console.log(`[transfer-inft]   metadataHash:       ${metadataHashBefore}`);

if (onChainOwnerBefore.toLowerCase() !== ownerAddress.toLowerCase()) {
  console.error(`[transfer-inft] FAIL: on-chain owner (${onChainOwnerBefore}) != expected ${ownerAddress}`);
  process.exit(1);
}

// ----- Step 2: owner unseals, recovers persistent symmetric key K -----------
const sealedBefore = Buffer.from(sealedHexBefore.slice(2), 'hex');
const symmetricKey = unsealSymmetricKey(new Uint8Array(sealedBefore), ownerPkBytes);
// Sanity: matches the on-disk persistent key.
const onDiskKey = loadAgentKey(join(REPO_ROOT, 'memory', abbr.toLowerCase(), 'og-key.bin'));
if (Buffer.compare(symmetricKey, onDiskKey) !== 0) {
  console.error('[transfer-inft] FAIL: unsealed key != on-disk persistent key (drift)');
  process.exit(1);
}
console.log('[transfer-inft]   unsealed symmetric key matches on-disk persistent key');

// ----- Step 3: generate fresh recipient keypair -----------------------------
const { privateKey: recipientPriv, publicKey: recipientPubKey } = generateSecpKeypair();
const recipientPrivHex = `0x${Buffer.from(recipientPriv).toString('hex')}` as Hex;
const recipientAccount = privateKeyToAccount(recipientPrivHex);
const recipientAddress = recipientAccount.address;
console.log(`[transfer-inft]   fresh recipient address: ${recipientAddress}`);

// ----- Step 4: re-seal K under recipient pubkey -----------------------------
const newSealed = sealSymmetricKey(symmetricKey, recipientPubKey);
const newSealedHex = `0x${Buffer.from(newSealed).toString('hex')}` as Hex;
const proof = metadataHashBefore as Hex; // MockOracle reads first 32B

// ----- Step 5: on-chain transfer --------------------------------------------
console.log('[transfer-inft] submitting INFT7857.transfer...');
const { tx } = await inft.transferIntelligence({
  from: ownerAddress,
  to: recipientAddress,
  tokenId,
  newSealedKey: newSealedHex,
  proof,
});
console.log(`[transfer-inft]   transfer tx: ${inft.txUrl(tx)}`);

// ----- Step 6: verify on-chain owner rotated --------------------------------
const onChainOwnerAfter = await inft.ownerOf(tokenId);
const sealedHexAfter = await inft.sealedKey(tokenId);
if (onChainOwnerAfter.toLowerCase() !== recipientAddress.toLowerCase()) {
  console.error(`[transfer-inft] FAIL: ownerOf after = ${onChainOwnerAfter} (expected ${recipientAddress})`);
  process.exit(1);
}
if (sealedHexAfter.toLowerCase() !== newSealedHex.toLowerCase()) {
  console.error('[transfer-inft] FAIL: on-chain sealedKey did not rotate');
  process.exit(1);
}
console.log(`[transfer-inft]   new owner on chain: ${onChainOwnerAfter}`);
console.log(`[transfer-inft]   sealedKey rotated   (${(sealedHexAfter.length - 2) / 2}B)`);

// ----- Step 7: fresh owner pass — decrypt with the brand-new PK -------------
console.log('[transfer-inft] fresh owner pulling encrypted blob...');
const rootHash = rootHashFromUri(await inft.encryptedURI(tokenId));
const blob = await storage.download(rootHash);
const symRecovered = unsealSymmetricKey(new Uint8Array(Buffer.from(sealedHexAfter.slice(2), 'hex')), recipientPriv);
if (Buffer.compare(symRecovered, symmetricKey) !== 0) {
  console.error('[transfer-inft] FAIL: recipient unseal != original symmetric key');
  process.exit(1);
}
const plaintext = decryptBundle(blob, symRecovered);
const computedHash = keccak256(plaintext);
const expectedHash = await inft.metadataHash(tokenId);
if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
  console.error('[transfer-inft] FAIL: metadataHash mismatch after transfer');
  process.exit(1);
}
const bundle = bundleFromBytes(plaintext);
const memState = bundle.memory_state as { tickCount?: number };

console.log('');
console.log(`=== ${abbr} agent recovered by fresh owner ${recipientAddress} ===`);
console.log(`  state            : ${bundle.state_name} (FIPS ${bundle.state_fips})`);
console.log(`  persona tagline  : ${(bundle.persona as { tagline?: string }).tagline ?? '<unset>'}`);
console.log(`  bundle generated : ${bundle.generated_at}`);
console.log(`  tickCount        : ${memState.tickCount ?? 'n/a'}`);
console.log(`  recent_log       : ${bundle.recent_log.length} entries`);

// ----- Step 8: persist transfer transcript ----------------------------------
mkdirSync(TRANSFERS_DIR, { recursive: true });
const transcriptPath = join(TRANSFERS_DIR, `${abbr.toLowerCase()}.json`);
writeFileSync(
  transcriptPath,
  `${JSON.stringify(
    {
      state_abbr: abbr,
      token_id: tokenId.toString(),
      inft_contract: inftAddress,
      chain: '0g-galileo-testnet',
      transfer_tx: tx,
      transfer_explorer: inft.txUrl(tx),
      from: ownerAddress,
      to: recipientAddress,
      to_private_key_hex: recipientPrivHex,
      sealed_key_before: sealedHexBefore,
      sealed_key_after: sealedHexAfter,
      metadata_hash: expectedHash,
      encrypted_uri: await inft.encryptedURI(tokenId),
      bundle_summary: {
        state_name: bundle.state_name,
        state_fips: bundle.state_fips,
        tickCount: memState.tickCount,
        recent_log: bundle.recent_log.length,
      },
      verified_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log(`[transfer-inft] PASS — wrote transcript to ${transcriptPath}`);
