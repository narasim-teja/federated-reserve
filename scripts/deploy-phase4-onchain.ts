/**
 * Phase 4 — onchain backfill for the federation scale-up.
 *
 * Idempotent. Safe to re-run; each step checks the existing deployments
 * file (and on-chain state) and skips work that's already done.
 *
 * Steps:
 *   1. Deploy StateToken contracts for IL/WA/AK (Phase 4 deep states),
 *      mirroring the Phase 3 economic allocation (2M total supply, 1.9M
 *      to the agent wallet, 100k LP reserve at the deployer).
 *   2. Mint MockUSDC to IL/WA/AK agents (1M each working balance) +
 *      300k to the deployer (LP reserve for the 3 new pools).
 *   3. Mint USDC to the Treasury wallet (5M working balance for federal
 *      transfers — Phase 4 mechanic).
 *   4. Fund IL/WA/AK/Fed/Treasury wallets with native ETH for gas
 *      (0.025 ETH each from the deployer).
 *   5. Persist updated address book back to
 *      `contracts/deployments/unichain-sepolia.json`.
 *
 * Pool seeding for the 3 new pairs is in seed-phase4-pools.ts (separate
 * because the same RPC stale-read gotcha from Phase 3 needs the same
 * polling pattern).
 *
 * Run: bun run scripts/deploy-phase4-onchain.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from 'viem';
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
if (!DEPLOYER_PK || DEPLOYER_PK === '0xPLACEHOLDER') {
  throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing');
}

const chain = {
  id: CHAIN_ID,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

console.log(`[p4-deploy] chain=${CHAIN_ID}  deployer=${deployer.address}`);

// ---------- artifact loader -------------------------------------------------

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}
function loadArtifact(name: string): Artifact {
  const p = join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8')) as Artifact;
}

// ---------- state config ----------------------------------------------------

interface StateSpec {
  abbr: 'IL' | 'WA' | 'AK';
  fips: number;
  name: string;
  symbol: string;
  fullName: string;
}

const PHASE4_STATES: StateSpec[] = [
  { abbr: 'IL', fips: 17, name: 'Illinois', symbol: 'ILT', fullName: 'Illinois Treasury Token' },
  { abbr: 'WA', fips: 53, name: 'Washington', symbol: 'WAT', fullName: 'Washington Treasury Token' },
  { abbr: 'AK', fips: 2, name: 'Alaska', symbol: 'AKT', fullName: 'Alaska Treasury Token' },
];

function getEnvAddress(name: string): Address {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set in .env.local`);
  return v as Address;
}

// Allocation (mirrors Phase 3).
const STATE_TOKEN_INITIAL_SUPPLY = 2_000_000n * 10n ** 18n;
const STATE_TOKEN_TO_AGENT = 1_900_000n * 10n ** 18n;
const USDC_PER_AGENT = 1_000_000n * 10n ** 6n;
const USDC_LP_PER_POOL = 100_000n * 10n ** 6n;
const USDC_TO_TREASURY = 5_000_000n * 10n ** 6n; // federal transfer pool

// Native ETH funding for new agent wallets (gas budget).
const ETH_PER_NEW_AGENT = 25_000_000_000_000_000n; // 0.025 ETH

// ---------- helpers ---------------------------------------------------------

const usdcAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address) external view returns (uint256)',
]);
const stTokenAbi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) external view returns (uint256)',
]);

async function deploy(
  name: string,
  abi: unknown[],
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode,
    args: args as never,
  });
  console.log(`[p4-deploy] ${name}  tx=${hash}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) {
    throw new Error(`${name} deploy reverted (status=${r.status})`);
  }
  console.log(`[p4-deploy] ${name}  -> ${r.contractAddress}`);
  return r.contractAddress;
}

async function send(
  label: string,
  to: Address,
  abi: ReturnType<typeof parseAbi>,
  fn: string,
  args: readonly unknown[],
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: to,
    abi,
    functionName: fn,
    args: args as never,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted (tx=${hash})`);
  console.log(`[p4-deploy]   ${label}  tx=${hash}`);
  return hash;
}

// ---------- main ------------------------------------------------------------

if (!existsSync(DEPLOYMENTS_PATH)) {
  throw new Error(`deployments file missing: ${DEPLOYMENTS_PATH} — run Phase 3 deploy first`);
}
type Deployments = {
  contracts: {
    MockUSDC: { address: Address; decimals: number };
    StateTokens: Record<
      string,
      {
        address: Address;
        fips: number;
        name: string;
        symbol: string;
        decimals: 18;
        agent: Address;
      }
    >;
    INFT7857: { address: Address };
  };
  reserves: { perPoolUsdc: string; perPoolStateToken: string };
};
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as Deployments;
const usdcAddr = deployments.contracts.MockUSDC.address;

// Step 1 — StateTokens for IL/WA/AK (idempotent).
console.log('[p4-deploy] step 1: StateTokens IL/WA/AK');
const stateTokenArtifact = loadArtifact('StateToken');
const newlyDeployed: Set<string> = new Set();
for (const s of PHASE4_STATES) {
  if (deployments.contracts.StateTokens[s.abbr]) {
    console.log(
      `[p4-deploy]   ${s.abbr} already deployed at ${deployments.contracts.StateTokens[s.abbr].address} — skip`,
    );
    continue;
  }
  const addr = await deploy(
    `StateToken[${s.abbr}]`,
    stateTokenArtifact.abi,
    stateTokenArtifact.bytecode.object,
    [s.fullName, s.symbol, s.fips, deployer.address, STATE_TOKEN_INITIAL_SUPPLY],
  );
  const agent = getEnvAddress(`WALLET_${s.abbr}_ADDRESS`);
  deployments.contracts.StateTokens[s.abbr] = {
    address: addr,
    fips: s.fips,
    name: s.fullName,
    symbol: s.symbol,
    decimals: 18,
    agent,
  };
  newlyDeployed.add(s.abbr);
}
// persist after deploys before transfers in case of mid-run failure
writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));

// Step 2 — distribute StateTokens to agent wallets (idempotent — checks balance).
console.log('[p4-deploy] step 2: distribute StateToken to agent (1.9M each)');
for (const s of PHASE4_STATES) {
  const t = deployments.contracts.StateTokens[s.abbr];
  if (!t) throw new Error(`missing ${s.abbr} StateToken in deployments`);
  const bal = (await publicClient.readContract({
    address: t.address,
    abi: stTokenAbi,
    functionName: 'balanceOf',
    args: [t.agent],
  })) as bigint;
  if (bal >= STATE_TOKEN_TO_AGENT) {
    console.log(`[p4-deploy]   ${s.abbr} agent already has ${bal} — skip transfer`);
    continue;
  }
  await send(
    `${s.abbr}.transfer(agent, 1.9M)`,
    t.address,
    stTokenAbi,
    'transfer',
    [t.agent, STATE_TOKEN_TO_AGENT],
  );
}

// Step 3 — mint USDC: agents (1M each) + deployer LP reserve (300k) + Treasury (5M).
console.log('[p4-deploy] step 3: mint USDC');
async function ensureUsdcBalance(label: string, who: Address, target: bigint): Promise<void> {
  const bal = (await publicClient.readContract({
    address: usdcAddr,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [who],
  })) as bigint;
  if (bal >= target) {
    console.log(`[p4-deploy]   ${label} USDC=${bal / 10n ** 6n} ≥ target — skip`);
    return;
  }
  const need = target - bal;
  await send(`USDC.mint(${label}, ${need / 10n ** 6n})`, usdcAddr, usdcAbi, 'mint', [who, need]);
}

for (const s of PHASE4_STATES) {
  const t = deployments.contracts.StateTokens[s.abbr];
  await ensureUsdcBalance(`${s.abbr} agent`, t!.agent, USDC_PER_AGENT);
}
// Deployer LP reserve for 3 new pools.
const lpUsdcNeed = USDC_LP_PER_POOL * 3n;
await ensureUsdcBalance('deployer LP', deployer.address, lpUsdcNeed);

// Treasury federal pool.
const treasuryAddr = getEnvAddress('WALLET_TREASURY_ADDRESS');
await ensureUsdcBalance('Treasury', treasuryAddr, USDC_TO_TREASURY);

// Step 4 — fund native ETH for new agent wallets.
console.log('[p4-deploy] step 4: fund native ETH (0.025 ETH each) for new agents');
const newWalletNames: { name: string; envKey: string }[] = [
  { name: 'IL', envKey: 'WALLET_IL_ADDRESS' },
  { name: 'WA', envKey: 'WALLET_WA_ADDRESS' },
  { name: 'AK', envKey: 'WALLET_AK_ADDRESS' },
  { name: 'FED', envKey: 'WALLET_FED_ADDRESS' },
  { name: 'TREASURY', envKey: 'WALLET_TREASURY_ADDRESS' },
];
for (const w of newWalletNames) {
  const to = getEnvAddress(w.envKey);
  const bal = await publicClient.getBalance({ address: to });
  if (bal >= ETH_PER_NEW_AGENT) {
    console.log(`[p4-deploy]   ${w.name} ETH=${Number(bal) / 1e18} ≥ target — skip`);
    continue;
  }
  const need = ETH_PER_NEW_AGENT - bal;
  const tx = await wallet.sendTransaction({
    account: deployer,
    chain: null,
    to,
    value: need,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`[p4-deploy]   ${w.name} funded +${Number(need) / 1e18} ETH  tx=${tx}`);
}

// Persist again with everything finalized.
writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
console.log(`[p4-deploy] wrote ${DEPLOYMENTS_PATH}`);
console.log('[p4-deploy] ✓ done — next: bun run scripts/seed-phase4-pools.ts');
