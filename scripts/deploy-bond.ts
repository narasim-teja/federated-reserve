/**
 * Phase 3 — deploy a single demo BondToken issued by NY.
 *
 * Idempotent-by-bondId: if the deployments file already has a bond with the
 * same bondId, this script skips. Otherwise it deploys, then appends to
 * `contracts/deployments/unichain-sepolia.json` under `bonds.{bondId}`.
 *
 * The deployer wallet pays gas for the constructor; `issuer` is set to the
 * NY agent wallet so only NY can mint to bidders during the auction.
 *
 * Run: bun run scripts/deploy-bond.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, createPublicClient, createWalletClient, http } from 'viem';
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
const MA_ADDR = process.env.WALLET_MA_ADDRESS as Address;
if (!DEPLOYER_PK) throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing');
if (!MA_ADDR) throw new Error('WALLET_MA_ADDRESS missing');

// ---------- demo bond spec --------------------------------------------------
//
// Issued by MA. Why MA: in the local mesh MA is the bootstrap node that the
// other agents dial into, so the AXL spanning-tree converges fastest with
// MA as the destination of leaf→hub A2A traffic. Bonds issued by leaves
// (NY/CA/TX/FL) work in production with full geographic peering, but for
// the local 5-agent mesh we exercise the primary-issuance settlement path
// against the most reliably-routed peer.

const SPEC = {
  bondId: 'MA-2030-Q1-A',
  name: 'MA 4.25% 2030 Bond',
  symbol: 'MAB30',
  issuerFips: 25,
  issuerAddr: MA_ADDR,
  couponBps: 425, // 4.25%
  maturity: 1893456000n, // 2030-01-01 UTC
  // Small enough that any deep agent can bid without draining their USDC,
  // big enough to be visible on the explorer.
  principal: 1_000n * 10n ** 6n, // $1,000 face value (6 decimals)
};

// ---------- chain client ----------------------------------------------------

const chain = {
  id: CHAIN_ID,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

console.log(`[bond-deploy] chain=${CHAIN_ID}  deployer=${deployer.address}`);

// ---------- artifact --------------------------------------------------------

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}
function loadArtifact(name: string): Artifact {
  const p = join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8')) as Artifact;
}

const bondArt = loadArtifact('BondToken');

// ---------- main ------------------------------------------------------------

if (!existsSync(DEPLOYMENTS_PATH)) throw new Error('deployments file missing');
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as {
  contracts: { MockUSDC: { address: Address } };
  bonds?: Record<
    string,
    {
      bondId: string;
      address: Address;
      issuerFips: number;
      issuerAddr: Address;
      couponBps: number;
      maturity: string;
      principalUsdcBase: string;
      symbol: string;
      name: string;
      decimals: 6;
      deployTx: Hex;
    }
  >;
};

if (deployments.bonds?.[SPEC.bondId]) {
  console.log(`[bond-deploy] ${SPEC.bondId} already deployed at ${deployments.bonds[SPEC.bondId].address} — skip`);
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
console.log(`[bond-deploy] deploy tx=${tx}`);
const r = await publicClient.waitForTransactionReceipt({ hash: tx });
if (r.status !== 'success' || !r.contractAddress) {
  throw new Error(`bond deploy reverted (status=${r.status})`);
}
console.log(`[bond-deploy] ✓ ${SPEC.bondId} -> ${r.contractAddress} (issuer=MA ${MA_ADDR})`);

deployments.bonds = deployments.bonds ?? {};
deployments.bonds[SPEC.bondId] = {
  bondId: SPEC.bondId,
  address: r.contractAddress as Address,
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
console.log(`[bond-deploy] wrote ${DEPLOYMENTS_PATH}`);
