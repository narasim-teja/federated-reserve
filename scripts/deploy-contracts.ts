/**
 * Phase 3 — deploy Solidity contracts to Unichain Sepolia.
 *
 * Sequence:
 *   1. Deploy MockUSDC.
 *   2. Deploy one StateToken per Phase-3 state (5: MA, CA, TX, NY, FL).
 *      Each is deployed with `owner_ = deployer` and an initial supply that
 *      covers (a) the state agent's working balance and (b) the LP seed the
 *      next script pulls from.
 *   3. Deploy INFT7857 (skeleton — Phase 5 mints).
 *   4. Mint MockUSDC to each state wallet so they can buy other states' tokens.
 *   5. Distribute each StateToken to its corresponding state wallet (keeping
 *      the LP-seed reserve in the deployer for `seed-pools.ts`).
 *   6. Persist addresses + the LP-seed reserves to
 *      `contracts/deployments/unichain-sepolia.json` (atomic write).
 *
 * Run: bun run scripts/deploy-contracts.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------- env -------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'contracts', 'out');
const DEPLOYMENTS_DIR = join(REPO_ROOT, 'contracts', 'deployments');
const ENV_LOCAL = join(REPO_ROOT, '.env.local');

function loadEnv(): void {
  if (!existsSync(ENV_LOCAL)) return;
  const lines = readFileSync(ENV_LOCAL, 'utf8').split('\n');
  for (const raw of lines) {
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

// ---------- chain --------------------------------------------------------------

const unichainSepolia = {
  id: CHAIN_ID,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain: unichainSepolia, transport: http(RPC) });
const wallet = createWalletClient({
  account: deployer,
  chain: unichainSepolia,
  transport: http(RPC),
});

console.log(`[deploy] chain=${CHAIN_ID}  rpc=${RPC}`);
console.log(`[deploy] deployer=${deployer.address}`);

// ---------- artifact loader ----------------------------------------------------

interface Artifact {
  abi: unknown[];
  bytecode: { object: Hex };
}
function loadArtifact(name: string): Artifact {
  const p = join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as Artifact;
  if (!j.bytecode.object?.startsWith('0x')) {
    throw new Error(`bad bytecode in ${p}`);
  }
  return j;
}

// ---------- state config -------------------------------------------------------

interface StateSpec {
  abbr: 'MA' | 'CA' | 'TX' | 'NY' | 'FL';
  fips: number;
  name: string;
  symbol: string;
  fullName: string;
}

const STATES: StateSpec[] = [
  {
    abbr: 'MA',
    fips: 25,
    name: 'Massachusetts',
    symbol: 'MAT',
    fullName: 'Massachusetts Treasury Token',
  },
  { abbr: 'CA', fips: 6, name: 'California', symbol: 'CAT', fullName: 'California Treasury Token' },
  { abbr: 'TX', fips: 48, name: 'Texas', symbol: 'TXT', fullName: 'Texas Treasury Token' },
  { abbr: 'NY', fips: 36, name: 'New York', symbol: 'NYT', fullName: 'New York Treasury Token' },
  { abbr: 'FL', fips: 12, name: 'Florida', symbol: 'FLT', fullName: 'Florida Treasury Token' },
];

function stateWalletAddress(abbr: string): Address {
  const v = process.env[`WALLET_${abbr}_ADDRESS`];
  if (!v) throw new Error(`WALLET_${abbr}_ADDRESS not set`);
  return v as Address;
}

// Per-state economic allocation. 18 decimals for StateToken, 6 for USDC.
const STATE_TOKEN_INITIAL_SUPPLY = 2_000_000n * 10n ** 18n; // 2M tokens minted to deployer
const STATE_TOKEN_TO_AGENT = 1_900_000n * 10n ** 18n; // 1.9M sent to the state wallet
const STATE_TOKEN_LP_RESERVE = STATE_TOKEN_INITIAL_SUPPLY - STATE_TOKEN_TO_AGENT; // 100k per pool

const USDC_PER_STATE = 1_000_000n * 10n ** 6n; // 1M USDC working balance per state
const USDC_LP_RESERVE_PER_POOL = 100_000n * 10n ** 6n; // 100k USDC per pool

// ---------- deploys ----------------------------------------------------------

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
  console.log(`[deploy] ${name}  tx=${hash}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) {
    throw new Error(`${name} deploy reverted (status=${r.status})`);
  }
  console.log(`[deploy] ${name}  -> ${r.contractAddress}`);
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
  if (r.status !== 'success') {
    throw new Error(`${label} reverted (tx=${hash})`);
  }
  console.log(`[deploy]   ${label}  tx=${hash}`);
  return hash;
}

// ---------- main -------------------------------------------------------------

const mockUsdcArtifact = loadArtifact('MockUSDC');
const stateTokenArtifact = loadArtifact('StateToken');
const inftArtifact = loadArtifact('INFT7857');

console.log('[deploy] step 1: MockUSDC');
const usdcAddr = await deploy('MockUSDC', mockUsdcArtifact.abi, mockUsdcArtifact.bytecode.object);

console.log('[deploy] step 2: StateTokens');
const stateTokens: Record<string, { address: Address; agent: Address }> = {};
for (const s of STATES) {
  const addr = await deploy(
    `StateToken[${s.abbr}]`,
    stateTokenArtifact.abi,
    stateTokenArtifact.bytecode.object,
    [s.fullName, s.symbol, s.fips, deployer.address, STATE_TOKEN_INITIAL_SUPPLY],
  );
  stateTokens[s.abbr] = { address: addr, agent: stateWalletAddress(s.abbr) };
}

console.log('[deploy] step 3: INFT7857');
const inftAddr = await deploy('INFT7857', inftArtifact.abi, inftArtifact.bytecode.object, [
  deployer.address,
]);

console.log('[deploy] step 4: mint USDC to state wallets');
const usdcAbi = parseAbi(['function mint(address to, uint256 amount)']);
for (const s of STATES) {
  const agent = stateTokens[s.abbr].agent;
  await send(`USDC.mint(${s.abbr})`, usdcAddr, usdcAbi, 'mint', [agent, USDC_PER_STATE]);
}
// Reserve USDC for the LP seed (5 pools).
const lpUsdcReserve = USDC_LP_RESERVE_PER_POOL * BigInt(STATES.length);
await send('USDC.mint(deployerLP)', usdcAddr, usdcAbi, 'mint', [deployer.address, lpUsdcReserve]);

console.log('[deploy] step 5: distribute StateTokens to state wallets');
const stTokenAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
for (const s of STATES) {
  const t = stateTokens[s.abbr];
  await send(`${s.abbr}.transfer(agent, 1.9M)`, t.address, stTokenAbi, 'transfer', [
    t.agent,
    STATE_TOKEN_TO_AGENT,
  ]);
}

// ---------- persist addresses ------------------------------------------------

const deployments = {
  chain: 'unichain-sepolia',
  chainId: CHAIN_ID,
  rpc: RPC,
  deployer: deployer.address,
  deployedAt: new Date().toISOString(),
  contracts: {
    MockUSDC: { address: usdcAddr, decimals: 6 },
    StateTokens: Object.fromEntries(
      STATES.map((s) => [
        s.abbr,
        {
          address: stateTokens[s.abbr].address,
          fips: s.fips,
          name: s.fullName,
          symbol: s.symbol,
          decimals: 18,
          agent: stateTokens[s.abbr].agent,
        },
      ]),
    ),
    INFT7857: { address: inftAddr },
  },
  reserves: {
    perPoolUsdc: USDC_LP_RESERVE_PER_POOL.toString(),
    perPoolStateToken: STATE_TOKEN_LP_RESERVE.toString(),
  },
};

mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
const out = join(DEPLOYMENTS_DIR, 'unichain-sepolia.json');
writeFileSync(out, JSON.stringify(deployments, null, 2));
console.log(`[deploy] wrote ${out}`);

console.log('[deploy] ✓ done');
