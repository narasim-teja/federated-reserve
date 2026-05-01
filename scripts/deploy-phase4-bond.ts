/**
 * Phase 4 — deploy an IL-issued BondToken for the multi-bidder auction
 * gate test. Idempotent: skips if `IL-2030-Q2-A` already exists.
 *
 * Why IL specifically: gives the gate test a clean issuer wallet (no
 * Phase 3 bond history), and IL is one of the new Phase 4 deep states
 * so it exercises the full backfill in one path.
 *
 * Run: bun run scripts/deploy-phase4-bond.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, type Address, type Hex, createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const REPO_ROOT = join(import.meta.dir, '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'contracts', 'out');
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'contracts', 'deployments', 'unichain-sepolia.json');
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

const RPC = process.env.UNICHAIN_SEPOLIA_RPC ?? 'https://sepolia.unichain.org';
const CHAIN_ID = Number(process.env.UNICHAIN_SEPOLIA_CHAIN_ID ?? 1301);
const DEPLOYER_PK = (process.env.WALLET_DEPLOYER_PRIVATE_KEY ?? '') as Hex;
const IL_ADDR = process.env.WALLET_IL_ADDRESS as Address;
if (!DEPLOYER_PK) throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing');
if (!IL_ADDR) throw new Error('WALLET_IL_ADDRESS missing');

const SPEC = {
  bondId: 'IL-2030-Q2-A',
  name: 'IL 5.50% 2030 Bond',
  symbol: 'ILB30',
  issuerFips: 17,
  issuerAddr: IL_ADDR,
  couponBps: 550, // 5.50% — IL pays a wider coupon (pension-stressed persona)
  maturity: 1893456000n, // 2030-01-01 UTC
  // Larger principal for the multi-bidder demo: $5,000 face value
  principal: 5_000n * 10n ** 6n,
};

const chain = {
  id: CHAIN_ID,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

console.log(`[p4-bond-deploy] chain=${CHAIN_ID}  deployer=${deployer.address}`);

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}
const bondArt = JSON.parse(
  readFileSync(join(ARTIFACTS_DIR, 'BondToken.sol', 'BondToken.json'), 'utf8'),
) as Artifact;

if (!existsSync(DEPLOYMENTS_PATH)) throw new Error('deployments file missing');
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as {
  bonds?: Record<string, unknown>;
};

if (deployments.bonds?.[SPEC.bondId]) {
  console.log(`[p4-bond-deploy] ${SPEC.bondId} already exists — skip`);
  process.exit(0);
}

const tx = await wallet.deployContract({
  abi: bondArt.abi as never,
  bytecode: bondArt.bytecode.object,
  args: [
    SPEC.name,
    SPEC.symbol,
    SPEC.bondId,
    SPEC.issuerAddr,
    SPEC.issuerFips,
    SPEC.couponBps,
    SPEC.maturity,
    SPEC.principal,
  ] as never,
});
console.log(`[p4-bond-deploy] deploy tx=${tx}`);
const r = await publicClient.waitForTransactionReceipt({ hash: tx });
if (r.status !== 'success' || !r.contractAddress) {
  throw new Error(`bond deploy reverted (status=${r.status})`);
}
console.log(`[p4-bond-deploy] ✓ ${SPEC.bondId} -> ${r.contractAddress} (issuer=IL ${IL_ADDR})`);

deployments.bonds = deployments.bonds ?? {};
deployments.bonds[SPEC.bondId] = {
  bondId: SPEC.bondId,
  address: r.contractAddress,
  issuerFips: SPEC.issuerFips,
  issuerAddr: SPEC.issuerAddr,
  couponBps: SPEC.couponBps,
  maturity: SPEC.maturity.toString(),
  principalUsdcBase: SPEC.principal.toString(),
  symbol: SPEC.symbol,
  name: SPEC.name,
  decimals: 6,
  deployTx: tx,
};
writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
console.log(`[p4-bond-deploy] wrote ${DEPLOYMENTS_PATH}`);
