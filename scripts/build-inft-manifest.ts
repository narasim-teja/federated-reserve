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

const deployments = loadDeployments('unichain-sepolia');
const inftAddress =
  process.env.OG_INFT7857_ADDRESS ?? deployments.contracts.INFT7857?.address ?? 'pending_0g_deploy';
const chainId = Number(process.env.OG_CHAIN_ID ?? 16601);
const chain = '0g-testnet';

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
  const metadataHash = sha256(metadata);
  const ownerAddress =
    process.env[`WALLET_${state.abbr}_ADDRESS`] ??
    deployments.contracts.StateTokens?.[state.abbr]?.agent ??
    '';
  entries.push({
    state_fips: state.fips,
    state_abbr: state.abbr,
    state_name: state.name,
    owner_address: ownerAddress,
    token_id: null,
    mint_status: 'pending_0g',
    metadata_uri: `0g://pending/${state.abbr.toLowerCase()}/${metadataHash}`,
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
      explorer_url:
        inftAddress.startsWith('0x') && process.env.OG_EXPLORER_BASE_URL
          ? `${process.env.OG_EXPLORER_BASE_URL.replace(/\/$/, '')}/address/${inftAddress}`
          : '',
    },
  });
}

const manifest = {
  generated_at: new Date().toISOString(),
  mint_status: 'pending_0g',
  entries,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[inft-manifest] wrote ${entries.length} entries to ${OUT}`);
