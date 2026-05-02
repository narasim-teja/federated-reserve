/**
 * Phase 5 — deploy ERC-7857 iNFT contracts to 0G Galileo testnet.
 *
 * Two contracts, one tx each:
 *   1. MockOracle — verifies ERC-7857 transferIntelligence proofs
 *      (always-true; production swaps for TEE/ZK verifier).
 *   2. INFT7857 — the iNFT contract; admin = deployer, oracle = MockOracle.
 *
 * Persists addresses to `contracts/deployments/0g-galileo.json`.
 *
 * Run: bun run scripts/deploy-0g.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const REPO_ROOT = join(import.meta.dir, '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'contracts', 'out');
const DEPLOYMENTS_DIR = join(REPO_ROOT, 'contracts', 'deployments');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');

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

const RPC = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const EXPLORER = (process.env.OG_EXPLORER_BASE_URL ?? 'https://chainscan-galileo.0g.ai').replace(
  /\/$/,
  '',
);
const DEPLOYER_PK = (process.env.WALLET_DEPLOYER_PRIVATE_KEY ?? '') as Hex;
if (!DEPLOYER_PK || DEPLOYER_PK === '0xPLACEHOLDER') {
  throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing in .env.local');
}

const galileo = {
  id: CHAIN_ID,
  name: '0G-Galileo-Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain: galileo, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain: galileo, transport: http(RPC) });

console.log(`[deploy-0g] chain=${CHAIN_ID}  rpc=${RPC}`);
console.log(`[deploy-0g] deployer=${deployer.address}`);

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}
function loadArtifact(name: string): Artifact {
  const p = join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as Artifact;
  if (!j.bytecode.object?.startsWith('0x')) throw new Error(`bad bytecode in ${p}`);
  return j;
}

async function waitForReceipt(hash: Hex): Promise<{
  status: 'success' | 'reverted';
  contractAddress?: Address;
}> {
  // 0G testnet's RPC sometimes 404s on getTransactionReceipt for ~10s after tx
  // submission; viem's default retry is too aggressive. Poll manually.
  const start = Date.now();
  const timeoutMs = 90_000;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await publicClient.getTransactionReceipt({ hash });
      return { status: r.status, contractAddress: r.contractAddress ?? undefined };
    } catch {
      await new Promise((res) => setTimeout(res, 3_000));
    }
  }
  throw new Error(`receipt not found within ${timeoutMs}ms for ${hash}`);
}

async function deploy(
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<{ address: Address; tx: Hex }> {
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode,
    args: args as never,
  });
  console.log(`[deploy-0g] ${name}  tx=${hash}`);
  const r = await waitForReceipt(hash);
  if (r.status !== 'success' || !r.contractAddress) {
    throw new Error(`${name} deploy reverted (status=${r.status})`);
  }
  console.log(`[deploy-0g] ${name}  -> ${r.contractAddress}`);
  console.log(`[deploy-0g]   ${EXPLORER}/address/${r.contractAddress}`);
  return { address: r.contractAddress, tx: hash };
}

const oracleArtifact = loadArtifact('MockOracle');
const inftArtifact = loadArtifact('INFT7857');

const oracle = await deploy('MockOracle', oracleArtifact.abi, oracleArtifact.bytecode.object);
const inft = await deploy('INFT7857', inftArtifact.abi, inftArtifact.bytecode.object, [
  deployer.address,
  oracle.address,
]);

const deployments = {
  chain: '0g-galileo',
  chainId: CHAIN_ID,
  rpc: RPC,
  explorer: EXPLORER,
  deployer: deployer.address,
  deployedAt: new Date().toISOString(),
  contracts: {
    MockOracle: { address: oracle.address, deployTx: oracle.tx },
    INFT7857: { address: inft.address, oracle: oracle.address, deployTx: inft.tx },
  },
};

mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
const out = join(DEPLOYMENTS_DIR, '0g-galileo.json');
writeFileSync(out, `${JSON.stringify(deployments, null, 2)}\n`);
console.log(`[deploy-0g] wrote ${out}`);
console.log('[deploy-0g] PASS');
