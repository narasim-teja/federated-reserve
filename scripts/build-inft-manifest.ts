/**
 * Phase 5 iNFT manifest builder.
 *
 * This does not mint. It packages the real agent identity + memory proof we
 * will later pin/encrypt on 0G Storage and mint into ERC-7857 tokens.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadDeployments } from '../packages/shared/src/deployments.ts';
import { getPersona } from '../packages/shared/src/personas.ts';
import { STATES } from '../packages/shared/src/states.ts';

const ROOT = resolve(import.meta.dir, '..');
const ENV_LOCAL = join(ROOT, '.env.local');
const MEMORY_ROOT = resolve(process.env.MEMORY_ROOT ?? join(ROOT, 'memory'));
const OUT = resolve(process.env.INFT_MANIFEST_PATH ?? join(ROOT, '.data/inft-manifest.json'));

function loadEnv(): void {
  if (!existsSync(ENV_LOCAL)) return;
  for (const raw of readFileSync(ENV_LOCAL, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function tailJsonl(path: string, n: number): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function sha256(value: unknown): string {
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

loadEnv();

// 0G Galileo deployments — written by `scripts/deploy-0g.ts` and updated by
// `scripts/mint-inft.ts` with per-state minted iNFT records.
interface OgDeploymentsFile {
  chain?: string;
  chainId?: number;
  contracts?: { INFT7857?: { address?: string } };
  iNFTs?: Record<string, OgMintRecord>;
}
interface OgMintRecord {
  tokenId: string;
  state_abbr: string;
  state_name: string;
  owner_address: string;
  encrypted_uri: string;
  root_hash: string;
  metadata_hash: string;
  mint_tx: string;
  bundle_bytes: number;
  encrypted_bytes: number;
  minted_at: string;
}
const OG_DEPLOYMENTS_PATH = join(ROOT, 'contracts', 'deployments', '0g-galileo.json');
const ogDeployments: OgDeploymentsFile = (() => {
  try {
    return JSON.parse(readFileSync(OG_DEPLOYMENTS_PATH, 'utf8')) as OgDeploymentsFile;
  } catch {
    return {};
  }
})();
const ogMints = ogDeployments.iNFTs ?? {};

// Fall back to the legacy unichain deployment file only if 0G hasn't shipped yet.
const fallbackDeployments = (() => {
  try {
    return loadDeployments('unichain-sepolia');
  } catch {
    return null;
  }
})();
const inftAddress =
  process.env.OG_INFT7857_ADDRESS
  ?? ogDeployments.contracts?.INFT7857?.address
  ?? fallbackDeployments?.contracts.INFT7857?.address
  ?? 'pending_0g_deploy';
const chainId = Number(process.env.OG_CHAIN_ID ?? ogDeployments.chainId ?? 16602);
const chain = ogDeployments.chain ?? '0g-galileo';
const explorerBase = (process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai').replace(
  /\/$/,
  '',
);
const storageExplorerBase = (process.env.OG_STORAGE_EXPLORER_BASE_URL ?? 'https://storagescan-galileo.0g.ai').replace(
  /\/$/,
  '',
);

const entries = [];
for (const state of STATES.filter((s) => s.tier === 'deep')) {
  const persona = getPersona(state.abbr);
  const stateFile = join(MEMORY_ROOT, state.abbr.toLowerCase(), 'state.json');
  const logFile = join(MEMORY_ROOT, state.abbr.toLowerCase(), 'log.jsonl');
  const memoryState = await readJson<Record<string, unknown>>(stateFile, {});
  const logEntries = await tailJsonl(logFile, 24);
  const metadata = {
    version: 1,
    state,
    persona,
    memory_state: memoryState,
    recent_log: logEntries,
    generated_at: new Date().toISOString(),
  };
  const fallbackHash = sha256(metadata);
  const fallbackOwner =
    process.env[`WALLET_${state.abbr}_ADDRESS`] ??
    fallbackDeployments?.contracts.StateTokens?.[state.abbr]?.agent ??
    '';
  const minted = ogMints[state.abbr];
  const isMinted = !!minted;
  const tokenIdNum = minted ? Number(minted.tokenId) : null;
  const ownerAddress = minted?.owner_address ?? fallbackOwner;
  const metadataUri = minted?.encrypted_uri ?? `0g://pending/${state.abbr.toLowerCase()}/${fallbackHash}`;
  const metadataHash = minted?.metadata_hash ?? fallbackHash;
  const tokenExplorerUrl = inftAddress.startsWith('0x') ? `${explorerBase}/address/${inftAddress}` : '';
  const mintTxUrl = minted?.mint_tx ? `${explorerBase}/tx/${minted.mint_tx}` : '';
  const storageBlobUrl = minted?.root_hash ? `${storageExplorerBase}/tx/${minted.root_hash}` : '';

  entries.push({
    state_fips: state.fips,
    state_abbr: state.abbr,
    state_name: state.name,
    owner_address: ownerAddress,
    token_id: tokenIdNum,
    mint_status: isMinted ? 'minted' : 'pending_0g',
    metadata_uri: metadataUri,
    metadata_hash: metadataHash,
    persona_tagline: persona.tagline,
    memory_proof: {
      state_file: stateFile,
      log_file: logFile,
      log_entries_included: logEntries.length,
      latest_log_timestamp: (logEntries.at(-1)?.timestamp as string | undefined) ?? null,
    },
    contract: {
      chain,
      chain_id: chainId,
      address: inftAddress,
      explorer_url: tokenExplorerUrl,
    },
    onchain: isMinted
      ? {
          mint_tx: minted!.mint_tx,
          mint_tx_url: mintTxUrl,
          storage_root_hash: minted!.root_hash,
          storage_blob_url: storageBlobUrl,
          encrypted_bytes: minted!.encrypted_bytes,
          minted_at: minted!.minted_at,
        }
      : null,
  });
}

const mintedCount = entries.filter((e) => e.mint_status === 'minted').length;
const manifest = {
  generated_at: new Date().toISOString(),
  mint_status: mintedCount === entries.length && entries.length > 0
    ? 'minted'
    : mintedCount > 0
      ? 'partial'
      : 'pending_0g',
  contract_address: inftAddress,
  contract_explorer_url: inftAddress.startsWith('0x') ? `${explorerBase}/address/${inftAddress}` : '',
  chain,
  chain_id: chainId,
  minted: mintedCount,
  entries,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[inft-manifest] wrote ${entries.length} entries to ${OUT}`);
