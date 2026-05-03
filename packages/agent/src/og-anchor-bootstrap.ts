/**
 * Optional 0G iNFT memory anchoring for the agent runtime.
 *
 * Activated by `OG_ANCHOR_ENABLED=1` (default off). When active, wraps the
 * base AgentMemory in [`OgAnchoredMemory`](./og-anchor.ts) so every
 * meaningful state change mirrors to 0G as an `INFT7857.updateMetadata`
 * call. Returns the original memory unchanged if any required env or file
 * is missing, so unfunded / unminted agents stay in pure-local mode.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import { loadAgentKey } from '@federated-reserve/og-inft';
import type { StateInfo } from '@federated-reserve/shared';
import type { AgentMemory } from './memory.ts';
import { OgAnchoredMemory } from './og-anchor.ts';

interface DeploymentsFile {
  contracts?: { INFT7857?: { address: string } };
  iNFTs?: Record<string, { tokenId?: string }>;
}

export function maybeWrapWithOgAnchor(
  memory: AgentMemory,
  state: StateInfo,
  persona: unknown,
): AgentMemory {
  if (process.env.OG_ANCHOR_ENABLED !== '1') return memory;

  const repoRoot = resolve(process.cwd(), process.env.REPO_ROOT_REL ?? '.');
  const deploymentsPath = process.env.OG_DEPLOYMENTS_PATH
    ?? findDeploymentsFile(repoRoot)
    ?? join(repoRoot, 'contracts/deployments/0g-galileo.json');
  if (!existsSync(deploymentsPath)) {
    console.log(`[og-anchor] disabled — no deployments file at ${deploymentsPath}`);
    return memory;
  }
  const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as DeploymentsFile;
  const inftAddress = deployments.contracts?.INFT7857?.address as Address | undefined;
  const tokenIdStr = deployments.iNFTs?.[state.abbr]?.tokenId;
  if (!inftAddress || !tokenIdStr) {
    console.log(`[og-anchor] disabled — no iNFT recorded for ${state.abbr}`);
    return memory;
  }

  const memoryRoot = process.env.MEMORY_ROOT ?? join(repoRoot, 'memory');
  const keyPath = join(memoryRoot, state.abbr.toLowerCase(), 'og-key.bin');
  if (!existsSync(keyPath)) {
    console.log(`[og-anchor] disabled — no persistent key at ${keyPath} (run scripts/mint-inft.ts ${state.abbr})`);
    return memory;
  }

  // TRS uses TREASURY-prefixed wallet env vars (matches config.ts settlement
  // remap); every other agent's env-key matches its abbr.
  const walletEnvKey = state.abbr === 'TRS' ? 'TREASURY' : state.abbr;
  const ownerAddress = (process.env[`WALLET_${walletEnvKey}_ADDRESS`] ?? '') as Address;
  // Each agent signs `INFT7857.updateMetadata` with its OWN wallet so nonce
  // sequences don't collide. Fall back to deployer only if the per-agent key
  // is missing (read-only nodes, demo runs without funded wallets).
  const perAgentKey = process.env[`WALLET_${walletEnvKey}_PRIVATE_KEY`];
  const usingPerAgent = !!perAgentKey && perAgentKey.startsWith('0x') && perAgentKey !== '0xPLACEHOLDER';
  const signerKey = (process.env.OG_ANCHOR_SIGNER_PK
    ?? (usingPerAgent ? perAgentKey : undefined)
    ?? process.env.WALLET_DEPLOYER_PRIVATE_KEY
    ?? '') as Hex;
  if (!ownerAddress || !signerKey) {
    console.log(`[og-anchor] disabled — missing owner or signer env`);
    return memory;
  }
  const signerSource = process.env.OG_ANCHOR_SIGNER_PK
    ? 'OG_ANCHOR_SIGNER_PK'
    : usingPerAgent
      ? `WALLET_${walletEnvKey}_PRIVATE_KEY (per-agent)`
      : 'WALLET_DEPLOYER_PRIVATE_KEY (fallback)';

  const symmetricKey = loadAgentKey(keyPath);

  const wrapped = new OgAnchoredMemory({
    base: memory,
    stateAbbr: state.abbr,
    stateName: state.name,
    stateFips: state.fips,
    persona,
    tokenId: BigInt(tokenIdStr),
    ownerAddress,
    symmetricKey,
    signerPrivateKey: signerKey,
    ogConfig: {
      rpcUrl: process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
      indexerUrl: process.env.OG_INDEXER_RPC ?? 'https://indexer-storage-testnet-turbo.0g.ai',
      chainId: Number(process.env.OG_CHAIN_ID ?? 16602),
      inftAddress,
      explorerBase: process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai',
    },
    policy: {
      minIntervalMs: Number(process.env.OG_ANCHOR_MIN_INTERVAL_MS ?? 90_000),
      tickHeartbeat: Number(process.env.OG_ANCHOR_TICK_HEARTBEAT ?? 6),
      reserveRatioDeltaBps: Number(process.env.OG_ANCHOR_RESERVE_RATIO_BPS ?? 100),
      totalValueDeltaBps: Number(process.env.OG_ANCHOR_VALUE_BPS ?? 50),
      compositionDeltaBps: Number(process.env.OG_ANCHOR_COMPOSITION_BPS ?? 500),
      decisionTriggers: process.env.OG_ANCHOR_DECISION_TRIGGERS !== '0',
    },
  });
  console.log(
    `[og-anchor] enabled — token=${tokenIdStr} contract=${inftAddress} signer=${signerKey.slice(0, 10)}… via=${signerSource}`,
  );
  return wrapped;
}

function findDeploymentsFile(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'contracts', 'deployments', '0g-galileo.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
