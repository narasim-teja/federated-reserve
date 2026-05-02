/**
 * Spike 08 — upload a tiny JSON blob to 0G Storage, then download it back
 * by root hash and assert the bytes round-trip.
 *
 * Required env (loaded from repo .env.local by run.sh):
 *   OG_RPC_URL, OG_INDEXER_RPC, WALLET_DEPLOYER_PRIVATE_KEY
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('0xPLACEHOLDER') || v === 'PLACEHOLDER') {
    console.error(`[spike-08] missing env ${name}`);
    process.exit(2);
  }
  return v;
}

const OG_RPC_URL = need('OG_RPC_URL');
const OG_INDEXER_RPC = need('OG_INDEXER_RPC');
const PK = need('WALLET_DEPLOYER_PRIVATE_KEY');
const STORAGE_EXPLORER =
  process.env.OG_STORAGE_EXPLORER_BASE_URL ?? 'https://storagescan-galileo.0g.ai';

const provider = new JsonRpcProvider(OG_RPC_URL);
const signer = new Wallet(PK, provider);
const payload = { hello: '0G', ts: new Date().toISOString(), spike: '08' };
const bytes = new TextEncoder().encode(JSON.stringify(payload));

console.log(`[spike-08] payload (${bytes.length} bytes): ${JSON.stringify(payload)}`);
console.log(`[spike-08] indexer: ${OG_INDEXER_RPC}`);

const indexer = new Indexer(OG_INDEXER_RPC);
const file = new MemData(bytes);

const [tree, treeErr] = await file.merkleTree();
if (treeErr !== null || !tree) {
  console.error(`[spike-08] FAIL merkleTree: ${treeErr}`);
  process.exit(1);
}
const localRoot = tree.rootHash();
console.log(`[spike-08] local merkle root: ${localRoot}`);

console.log('[spike-08] uploading (this anchors on-chain; takes ~10-30s)...');
const t0 = Date.now();
const [uploadResult, uploadErr] = await indexer.upload(file, OG_RPC_URL, signer);
if (uploadErr !== null) {
  console.error(`[spike-08] FAIL upload: ${uploadErr.message ?? uploadErr}`);
  process.exit(1);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const rootHash =
  'rootHash' in uploadResult ? uploadResult.rootHash : uploadResult.rootHashes[0];
const txHash = 'txHash' in uploadResult ? uploadResult.txHash : uploadResult.txHashes[0];
console.log(`[spike-08] uploaded in ${elapsed}s`);
console.log(`[spike-08]   rootHash: ${rootHash}`);
console.log(`[spike-08]   txHash:   ${txHash}`);
console.log(`[spike-08]   storagescan: ${STORAGE_EXPLORER}/tx/${rootHash}`);

if (rootHash !== localRoot) {
  console.error(`[spike-08] FAIL local merkle root != server root`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'spike-08-'));
const outPath = join(tmp, 'roundtrip.json');

console.log('[spike-08] downloading by root hash (give the network a moment)...');
let downErr: Error | null = null;
for (let i = 0; i < 8; i += 1) {
  downErr = await indexer.download(rootHash, outPath, false);
  if (downErr === null) break;
  console.log(`[spike-08]   download attempt ${i + 1}/8 -> ${downErr.message ?? downErr}`);
  await new Promise((r) => setTimeout(r, 5_000));
}
if (downErr !== null) {
  console.error(`[spike-08] FAIL download: ${downErr.message ?? downErr}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const downloaded = readFileSync(outPath);
const downloadedHex = Buffer.from(downloaded).toString('hex');
const expectedHex = Buffer.from(bytes).toString('hex');

if (downloadedHex !== expectedHex) {
  console.error('[spike-08] FAIL: downloaded bytes != uploaded bytes');
  console.error(`  uploaded: ${expectedHex}`);
  console.error(`  got:      ${downloadedHex}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

console.log(`[spike-08] PASS — ${downloaded.length} bytes round-tripped through 0G Storage`);
rmSync(tmp, { recursive: true, force: true });

writeFileSync(
  join(import.meta.dir, 'last-run.json'),
  JSON.stringify({ rootHash, txHash, payload, at: new Date().toISOString() }, null, 2),
);
