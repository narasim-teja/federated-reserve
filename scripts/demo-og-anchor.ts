/**
 * Stop 5 demo — exercise OgAnchoredMemory in isolation.
 *
 * Loads MA's existing local memory, wraps it with the 0G iNFT anchor, then
 * simulates 4 ticks of state evolution (composition rebalance, value drift,
 * a decision log entry, and a heartbeat) so we can watch live
 * `MetadataUpdated` events stream into the contract on 0G testnet.
 *
 * After the run, decrypt-inft.ts will show the agent's tickCount has
 * advanced past the original mint snapshot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDiskMemory } from '../packages/agent/src/memory.ts';
import { OgAnchoredMemory } from '../packages/agent/src/og-anchor.ts';
import type { AgentState } from '../packages/agent/src/state.ts';
import { loadAgentKey } from '../packages/og-inft/src/index.ts';
import { getPersona } from '../packages/shared/src/personas.ts';
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

const abbr = (process.argv[2] ?? 'MA').toUpperCase();
const stateDef = STATES.find((s) => s.abbr === abbr);
if (!stateDef) {
  console.error(`unknown state ${abbr}`);
  process.exit(2);
}
const persona = getPersona(abbr);

const RPC = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const INDEXER = process.env.OG_INDEXER_RPC ?? 'https://indexer-storage-testnet-turbo.0g.ai';
const CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const EXPLORER = process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai';

const ownerPk = process.env[`WALLET_${abbr}_PRIVATE_KEY`] as Hex | undefined;
const ownerAddress = process.env[`WALLET_${abbr}_ADDRESS`] as Address | undefined;
if (!ownerPk || !ownerAddress) {
  console.error(`WALLET_${abbr}_PRIVATE_KEY/ADDRESS not set`);
  process.exit(2);
}
const signerPk = (process.env.OG_ANCHOR_SIGNER_PK ??
  process.env.WALLET_DEPLOYER_PRIVATE_KEY) as Hex;
if (!signerPk) {
  console.error('no signer PK (set WALLET_DEPLOYER_PRIVATE_KEY or OG_ANCHOR_SIGNER_PK)');
  process.exit(2);
}

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const inftAddress = deployments.contracts.INFT7857.address as Address;
const tokenRecord = deployments.iNFTs?.[abbr];
if (!tokenRecord) {
  console.error(`no minted iNFT recorded for ${abbr} — run scripts/mint-inft.ts ${abbr} first`);
  process.exit(2);
}
const tokenId = BigInt(tokenRecord.tokenId);

console.log(
  `[demo-og-anchor] state=${abbr} tokenId=${tokenId} owner=${ownerAddress} signer=${signerPk.slice(0, 10)}...`,
);

const memoryRoot = process.env.MEMORY_ROOT ?? join(REPO_ROOT, 'memory');
const base = new LocalDiskMemory({ agentKey: abbr.toLowerCase(), rootDir: memoryRoot });

const symmetricKey = loadAgentKey(join(memoryRoot, abbr.toLowerCase(), 'og-key.bin'));

const anchored = new OgAnchoredMemory({
  base,
  stateAbbr: abbr,
  stateName: stateDef.name,
  stateFips: stateDef.fips,
  persona,
  tokenId,
  ownerAddress,
  symmetricKey,
  signerPrivateKey: signerPk,
  ogConfig: { rpcUrl: RPC, indexerUrl: INDEXER, chainId: CHAIN_ID, inftAddress, explorerBase: EXPLORER },
  // For the demo, lower the throttle so each simulated tick fires.
  policy: {
    minIntervalMs: 5_000,
    tickHeartbeat: 1,
    reserveRatioDeltaBps: 1,
    totalValueDeltaBps: 1,
    compositionDeltaBps: 1,
    decisionTriggers: true,
  },
  recentLogLimit: 16,
});

const initial = (await anchored.loadState()) as AgentState | null;
if (!initial) {
  console.error(`no local state for ${abbr}; run the mesh once first`);
  process.exit(2);
}
console.log(`[demo-og-anchor] starting at tickCount=${initial.tickCount}, value=${initial.totalValueUsd}`);

const stages: Array<{ label: string; mutate: (s: AgentState) => void }> = [
  {
    label: 'tick + small value drift',
    mutate: (s) => {
      s.tickCount += 1;
      s.totalValueUsd = Math.round(s.totalValueUsd * 1.002);
    },
  },
  {
    label: 'reserve ratio bump (200 bps)',
    mutate: (s) => {
      s.tickCount += 1;
      s.reserveRatio = Math.min(0.5, s.reserveRatio + 0.02);
    },
  },
  {
    label: 'composition rebalance',
    mutate: (s) => {
      s.tickCount += 1;
      s.composition = s.composition.map((a) =>
        a.asset === 'USDC' ? { ...a, balance: `${BigInt(a.balance) + 1_000_000n}` } : a,
      );
    },
  },
  {
    label: 'decision log entry triggers anchor',
    mutate: (s) => {
      s.tickCount += 1;
    },
  },
];

let live = initial;
for (const [i, stage] of stages.entries()) {
  console.log(`\n[demo-og-anchor] === stage ${i + 1}/${stages.length}: ${stage.label} ===`);
  stage.mutate(live);
  if (stage.label.includes('decision')) {
    await anchored.appendLog({
      kind: 'decision',
      at: new Date().toISOString(),
      summary: `[demo] simulated decision @ tick ${live.tickCount}`,
    });
  }
  await anchored.saveState(live);

  // Wait for in-flight anchor to finish before moving on (demo only — runtime
  // would let it overlap with the next tick).
  for (let j = 0; j < 30; j += 1) {
    const stats = anchored.getStats();
    if (stats.inFlight === 0 && stats.attempts >= i + 1) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const stats = anchored.getStats();
  const last = stats.lastAnchor;
  if (last) {
    console.log(
      `[demo-og-anchor]   anchor #${stats.successes}: reason="${last.reason}" tick=${last.tickCount} root=${last.rootHash.slice(0, 14)}…`,
    );
    console.log(`[demo-og-anchor]   updateMetadata tx: ${EXPLORER}/tx/${last.updateMetadataTx}`);
  } else {
    console.log(`[demo-og-anchor]   no anchor recorded yet (lastError=${stats.lastError ?? 'none'})`);
  }
}

const finalStats = anchored.getStats();
console.log('\n[demo-og-anchor] final stats:', {
  attempts: finalStats.attempts,
  successes: finalStats.successes,
  failures: finalStats.failures,
  lastReason: finalStats.lastReason,
});
console.log(
  `[demo-og-anchor] view all updates: ${EXPLORER}/address/${inftAddress}#events`,
);
console.log(
  `[demo-og-anchor] verify with: bun run scripts/decrypt-inft.ts ${abbr}`,
);

if (finalStats.successes === 0) {
  console.error('[demo-og-anchor] FAIL: no anchors landed');
  process.exit(1);
}
console.log('[demo-og-anchor] PASS');
