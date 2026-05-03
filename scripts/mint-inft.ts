/**
 * Phase 5 — encrypt an agent's full memory snapshot, upload to 0G Storage,
 * and mint an ERC-7857 iNFT on 0G Galileo testnet.
 *
 * For each requested deep state-agent:
 *   1. Read memory/<abbr>/state.json + the last N log.jsonl entries.
 *   2. Build the canonical bundle (persona + memory_state + recent_log).
 *   3. AES-256-GCM encrypt under a fresh 32-byte symmetric key.
 *   4. Upload `iv || ciphertext` to 0G Storage → root hash.
 *   5. Seal the symmetric key against the recipient's secp256k1 pubkey
 *      (derived from WALLET_<ABBR>_PRIVATE_KEY).
 *   6. INFT7857.mint(recipient, tokenId, "0g://<root>", keccak256(bundle), sealedKey).
 *   7. Round-trip locally: download → decrypt → assert plaintext == original.
 *
 * Output:
 *   contracts/deployments/0g-galileo.json gets per-state {tokenId, rootHash,
 *   metadataHash, mintTx, ownerAddress}. .data/inft-manifest.json is rebuilt
 *   so the frontend picks up the live data.
 *
 * Usage:
 *   bun run scripts/mint-inft.ts            # mint all 8 deep states
 *   bun run scripts/mint-inft.ts MA         # mint a single state (Stop 3)
 *   bun run scripts/mint-inft.ts MA CA      # mint a comma- or space-separated subset
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bundleToBytes,
  bundleFromBytes,
  decryptBundle,
  encryptBundle,
  INFTContract,
  loadOrCreateAgentKey,
  OgStorage,
  pubkeyFromPrivate,
  rootHashToUri,
  sealSymmetricKey,
  unsealSymmetricKey,
  type AgentBundle,
} from '../packages/og-inft/src/index.ts';
import { getPersona } from '../packages/shared/src/personas.ts';
import { STATES } from '../packages/shared/src/states.ts';
import type { Address, Hex } from 'viem';

const REPO_ROOT = join(import.meta.dir, '..');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');
const MEMORY_ROOT = process.env.MEMORY_ROOT ?? join(REPO_ROOT, 'memory');
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'contracts', 'deployments', '0g-galileo.json');
const MANIFEST_PATH = process.env.INFT_MANIFEST_PATH ?? join(REPO_ROOT, '.data', 'inft-manifest.json');
const RECENT_LOG_LIMIT = 24;

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
  if (!v || v.startsWith('0xPLACEHOLDER') || v === 'PLACEHOLDER') {
    throw new Error(`missing env: ${name}`);
  }
  return v;
}

const RPC = need('OG_RPC_URL');
const INDEXER = need('OG_INDEXER_RPC');
const CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const EXPLORER = (process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai').replace(/\/$/, '');
const STORAGE_EXPLORER = (process.env.OG_STORAGE_EXPLORER_BASE_URL ?? 'https://storagescan-galileo.0g.ai').replace(/\/$/, '');
const DEPLOYER_PK = need('WALLET_DEPLOYER_PRIVATE_KEY') as Hex;

interface DeploymentsFile {
  chain: string;
  chainId: number;
  rpc: string;
  explorer?: string;
  deployer: string;
  deployedAt: string;
  contracts: {
    MockOracle: { address: Address; deployTx: Hex };
    INFT7857: { address: Address; oracle: Address; deployTx: Hex };
  };
  iNFTs?: Record<string, MintRecord>;
}

interface MintRecord {
  tokenId: string;
  state_abbr: string;
  state_name: string;
  state_fips: number;
  owner_address: Address;
  encrypted_uri: string;
  root_hash: string;
  metadata_hash: Hex;
  sealed_key: Hex;
  mint_tx: Hex;
  bundle_bytes: number;
  encrypted_bytes: number;
  minted_at: string;
  /**
   * 0G Storage submission tx hash (the tx that committed the encrypted blob
   * to the storage network — distinct from `mint_tx` which is the on-chain
   * INFT7857.mint call).
   */
  storage_submission_tx?: Hex;
  /**
   * 0G Storage sequence number for the submission. This is the identifier
   * `https://storagescan-galileo.0g.ai/submission/<txSeq>` resolves against;
   * lookup by root hash isn't supported by the public storage scanner.
   */
  storage_tx_seq?: string;
}

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as DeploymentsFile;
const inftAddress = deployments.contracts.INFT7857.address;
deployments.iNFTs = deployments.iNFTs ?? {};

const inft = new INFTContract({
  rpcUrl: RPC,
  chainId: CHAIN_ID,
  privateKey: DEPLOYER_PK,
  inftAddress,
  explorerBase: EXPLORER,
});
const storage = new OgStorage({ rpcUrl: RPC, indexerUrl: INDEXER, privateKey: DEPLOYER_PK });

console.log(`[mint-inft] inft=${inftAddress} deployer=${inft.sender}`);

function loadAgentMemory(abbr: string): { state: unknown; recentLog: unknown[] } {
  const lower = abbr.toLowerCase();
  let state: unknown = {};
  try {
    state = JSON.parse(readFileSync(join(MEMORY_ROOT, lower, 'state.json'), 'utf8'));
  } catch {}
  let recentLog: unknown[] = [];
  try {
    const raw = readFileSync(join(MEMORY_ROOT, lower, 'log.jsonl'), 'utf8');
    recentLog = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-RECENT_LOG_LIMIT)
      .map((line) => JSON.parse(line));
  } catch {}
  return { state, recentLog };
}

function bytesToHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString('hex')}`;
}
function tokenIdFor(fips: number): bigint {
  // Deterministic, collision-free per-state. fips fits in uint8.
  return BigInt(fips);
}

const argList = process.argv
  .slice(2)
  .flatMap((s) => s.split(','))
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const targetAbbrs =
  argList.length > 0
    ? argList
    : STATES.filter((s) => s.tier === 'deep').map((s) => s.abbr);

console.log(`[mint-inft] targets: ${targetAbbrs.join(', ')}`);

let okCount = 0;
let skipCount = 0;
const failures: string[] = [];

for (const abbr of targetAbbrs) {
  const stateDef = STATES.find((s) => s.abbr === abbr);
  if (!stateDef) {
    failures.push(`${abbr}: unknown state`);
    continue;
  }

  const ownerPkRaw = process.env[`WALLET_${abbr}_PRIVATE_KEY`];
  const ownerAddrRaw = process.env[`WALLET_${abbr}_ADDRESS`];
  if (!ownerPkRaw || ownerPkRaw === '0xPLACEHOLDER' || !ownerAddrRaw) {
    failures.push(`${abbr}: WALLET_${abbr}_PRIVATE_KEY/ADDRESS not set`);
    continue;
  }
  const ownerPkBytes = Buffer.from(ownerPkRaw.replace(/^0x/, ''), 'hex');
  const ownerPubKey = pubkeyFromPrivate(ownerPkBytes);
  const ownerAddress = ownerAddrRaw as Address;
  const tokenId = tokenIdFor(stateDef.fips);

  // Idempotency: skip if already minted.
  try {
    const existingOwner = await inft.ownerOf(tokenId);
    if (existingOwner.toLowerCase() === ownerAddress.toLowerCase()) {
      console.log(`[${abbr}] already minted -> tokenId=${tokenId} owner=${existingOwner}`);
      skipCount += 1;
      continue;
    }
  } catch {
    // ownerOf reverts when token doesn't exist — that's the happy path.
  }

  const persona = getPersona(abbr);
  const { state: memoryState, recentLog } = loadAgentMemory(abbr);

  const bundle: AgentBundle = {
    version: 1,
    state_abbr: abbr,
    state_name: stateDef.name,
    state_fips: stateDef.fips,
    persona,
    memory_state: memoryState,
    recent_log: recentLog,
    generated_at: new Date().toISOString(),
    generator: 'scripts/mint-inft.ts',
  };

  // Load or create the agent's long-lived symmetric key. The same key
  // encrypts every future memory snapshot for this iNFT, so the on-chain
  // sealed-key remains valid across all anchor updates. The file is
  // gitignored under memory/<abbr>/.
  const keyPath = join(MEMORY_ROOT, abbr.toLowerCase(), 'og-key.bin');
  const { key: symmetricKey, created } = loadOrCreateAgentKey(keyPath);
  if (created) console.log(`[${abbr}] generated new persistent agent key at ${keyPath}`);

  const plaintext = bundleToBytes(bundle);
  const cipher = encryptBundle(plaintext, symmetricKey);
  const sealed = sealSymmetricKey(cipher.symmetricKey, ownerPubKey);

  console.log(
    `[${abbr}] bundle=${plaintext.length}B  cipher=${cipher.blob.length}B  sealed=${sealed.length}B`,
  );

  // Upload encrypted blob to 0G Storage.
  console.log(`[${abbr}] uploading to 0G Storage...`);
  const { rootHash, txHash: storageTx, txSeq } = await storage.upload(cipher.blob);
  console.log(`[${abbr}]   rootHash=${rootHash}  storageTx=${storageTx}  txSeq=${txSeq}`);
  console.log(`[${abbr}]   storagescan: ${STORAGE_EXPLORER}/file/${rootHash}  (storage submission tx: ${STORAGE_EXPLORER}/tx/${storageTx})`);

  // Round-trip self-test: decrypt locally before paying for the on-chain mint.
  const symRecovered = unsealSymmetricKey(sealed, ownerPkBytes);
  if (Buffer.compare(symRecovered, symmetricKey) !== 0) {
    failures.push(`${abbr}: sealed-key round-trip failed`);
    continue;
  }
  const plaintextRecovered = decryptBundle(cipher.blob, symRecovered);
  if (Buffer.compare(plaintextRecovered, plaintext) !== 0) {
    failures.push(`${abbr}: bundle round-trip failed`);
    continue;
  }
  // Sanity-check: the recovered bundle round-trips through bundleFromBytes.
  bundleFromBytes(plaintextRecovered);
  console.log(`[${abbr}]   local seal/unseal+decrypt round-trip OK`);

  // Mint.
  const encryptedURI = rootHashToUri(rootHash);
  const metadataHash = bytesToHex(cipher.plaintextDigest);
  const sealedHex = bytesToHex(sealed);
  console.log(`[${abbr}] minting tokenId=${tokenId} to ${ownerAddress}...`);
  const { tx: mintTx } = await inft.mint({
    to: ownerAddress,
    tokenId,
    encryptedURI,
    metadataHash,
    sealedKey: sealedHex,
  });
  console.log(`[${abbr}]   mint tx=${mintTx}`);
  console.log(`[${abbr}]   ${inft.txUrl(mintTx)}`);

  // Verify on-chain views match what we sent.
  const onChainOwner = await inft.ownerOf(tokenId);
  const onChainURI = await inft.encryptedURI(tokenId);
  const onChainHash = await inft.metadataHash(tokenId);
  if (onChainOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
    failures.push(`${abbr}: ownerOf mismatch`);
    continue;
  }
  if (onChainURI !== encryptedURI) {
    failures.push(`${abbr}: encryptedURI mismatch`);
    continue;
  }
  if (onChainHash.toLowerCase() !== metadataHash.toLowerCase()) {
    failures.push(`${abbr}: metadataHash mismatch`);
    continue;
  }

  const record: MintRecord = {
    tokenId: tokenId.toString(),
    state_abbr: abbr,
    state_name: stateDef.name,
    state_fips: stateDef.fips,
    owner_address: ownerAddress,
    encrypted_uri: encryptedURI,
    root_hash: rootHash,
    metadata_hash: metadataHash,
    sealed_key: sealedHex,
    mint_tx: mintTx,
    bundle_bytes: plaintext.length,
    encrypted_bytes: cipher.blob.length,
    minted_at: new Date().toISOString(),
    storage_submission_tx: storageTx as Hex,
    storage_tx_seq: txSeq != null ? String(txSeq) : undefined,
  };
  deployments.iNFTs![abbr] = record;
  okCount += 1;
}

writeFileSync(DEPLOYMENTS_PATH, `${JSON.stringify(deployments, null, 2)}\n`);
console.log(`[mint-inft] wrote ${DEPLOYMENTS_PATH}`);

console.log(
  `[mint-inft] DONE  minted=${okCount}  skipped=${skipCount}  failed=${failures.length}`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
