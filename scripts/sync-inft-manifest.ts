/**
 * Reconcile `contracts/deployments/0g-galileo.json` with any iNFT transfer
 * logs under `.data/inft-transfers/<abbr>.json`. After a `transfer-inft.ts`
 * ceremony moves an iNFT to a fresh owner, the manifest's `owner_address`,
 * `sealed_key`, `metadata_hash`, and `encrypted_uri` are stale — running
 * this brings them back in sync so the dashboard's owner-match indicator
 * reflects the current state.
 *
 * Idempotent: re-running with no new transfer logs is a no-op.
 *
 * Usage:
 *   bun run scripts/sync-inft-manifest.ts            # apply all
 *   bun run scripts/sync-inft-manifest.ts --dry-run  # preview only
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const MANIFEST = join(REPO_ROOT, 'contracts', 'deployments', '0g-galileo.json');
const TRANSFERS_DIR = join(REPO_ROOT, '.data', 'inft-transfers');

const dryRun = process.argv.includes('--dry-run');

interface TransferRecord {
  state_abbr: string;
  token_id: string;
  inft_contract: string;
  transfer_tx: string;
  transfer_explorer: string;
  from: string;
  to: string;
  sealed_key_after: string;
  metadata_hash: string;
  encrypted_uri: string;
  verified_at: string;
}

interface InftEntry {
  tokenId: string;
  state_abbr: string;
  state_name: string;
  state_fips: number;
  owner_address: string;
  encrypted_uri: string;
  root_hash: string;
  metadata_hash: string;
  sealed_key: string;
  mint_tx: string;
  bundle_bytes: number;
  encrypted_bytes: number;
  minted_at: string;
  /** History trail — appended each time the manifest is synced from a new transfer. */
  transfer_history?: Array<{
    from: string;
    to: string;
    tx: string;
    explorer: string;
    at: string;
  }>;
}

interface ManifestFile {
  iNFTs?: Record<string, InftEntry>;
  [key: string]: unknown;
}

if (!existsSync(MANIFEST)) {
  console.error(`manifest missing: ${MANIFEST}`);
  process.exit(1);
}

if (!existsSync(TRANSFERS_DIR)) {
  console.log(`no transfer logs at ${TRANSFERS_DIR} — nothing to sync`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestFile;
const inftMap = manifest.iNFTs ?? {};

const files = readdirSync(TRANSFERS_DIR).filter((f) => f.endsWith('.json'));
let updated = 0;
let skipped = 0;

for (const file of files) {
  const abbr = file.replace(/\.json$/, '').toUpperCase();
  const record = JSON.parse(
    readFileSync(join(TRANSFERS_DIR, file), 'utf8'),
  ) as TransferRecord;
  const entry = inftMap[abbr];
  if (!entry) {
    console.log(`  skip ${abbr}: no manifest entry`);
    skipped++;
    continue;
  }
  if (entry.owner_address.toLowerCase() === record.to.toLowerCase()) {
    console.log(`  ✓ ${abbr}: already in sync (owner=${record.to})`);
    skipped++;
    continue;
  }
  const before = entry.owner_address;
  entry.owner_address = record.to;
  entry.sealed_key = record.sealed_key_after;
  entry.metadata_hash = record.metadata_hash;
  entry.encrypted_uri = record.encrypted_uri;
  // Derive root hash from the encrypted URI (rootHashToUri reverse).
  const root = record.encrypted_uri.startsWith('0g://')
    ? `0x${record.encrypted_uri.slice(5)}`
    : entry.root_hash;
  entry.root_hash = root;
  entry.transfer_history = entry.transfer_history ?? [];
  entry.transfer_history.push({
    from: record.from,
    to: record.to,
    tx: record.transfer_tx,
    explorer: record.transfer_explorer,
    at: record.verified_at,
  });
  updated++;
  console.log(
    `  ${dryRun ? '[dry-run] would update' : 'update'} ${abbr}: ${before.slice(0, 10)}… → ${record.to.slice(0, 10)}…`,
  );
}

if (updated > 0 && !dryRun) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${MANIFEST}`);
}

console.log(`\nsummary: updated=${updated} skipped=${skipped} files=${files.length}`);
