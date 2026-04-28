/**
 * Phase 3 — retry pool LP mints for entries where the first run reverted.
 *
 * Why this exists: Unichain Sepolia's RPC node sometimes returns stale state
 * for ~1-3 seconds after a write. `seed-pools.ts` calls
 * createAndInitializePoolIfNecessary then immediately mint; for 3 of 5 pools
 * the mint hit stale state and reverted with the pool storage slot for
 * sqrtPriceX96 still reading 0. This script confirms each pool is properly
 * initialized via factory.getPool, then retries only the mint leg.
 *
 * Idempotent: skips any pool whose deployments entry already has a non-zero
 * tokenId.
 *
 * Run: bun run scripts/seed-pools-retry.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const REPO_ROOT = join(import.meta.dir, '..');
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
if (!DEPLOYER_PK) throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing');

const NPM: Address = '0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075';
const FACTORY: Address = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE = 3000;
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const chain = {
  id: CHAIN_ID,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const deployer = privateKeyToAccount(DEPLOYER_PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

const npmAbi = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);
const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);
const poolAbi = parseAbi(['function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)']);

async function waitForPoolReady(token0: Address, token1: Address): Promise<Address> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const pool = (await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [token0, token1, FEE],
    })) as Address;
    if (pool !== ZERO_ADDRESS) {
      // Confirm the pool is initialized (slot0.sqrtPriceX96 > 0).
      const slot0 = (await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'slot0',
      })) as readonly [bigint, number, number, number, number, number, boolean];
      if (slot0[0] > 0n) return pool;
    }
    console.log(`[retry]   pool not ready (attempt ${attempt}); waiting 2s…`);
    await Bun.sleep(2000);
  }
  throw new Error(`pool ${token0}/${token1} never became ready`);
}

if (!existsSync(DEPLOYMENTS_PATH)) throw new Error('deployments file missing');
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const byState = deployments.pools?.byState as Record<string, {
  state: string;
  pair: string;
  token0: Address;
  token1: Address;
  fee: number;
  sqrtPriceX96: string;
  poolAddress: Address;
  tokenId: string;
  liquidity: string;
  amount0Used: string;
  amount1Used: string;
  initTx: Hex;
  mintTx: Hex;
}>;
if (!byState) throw new Error('no pools.byState — run seed-pools.ts first');

const perPoolUsdc = BigInt(deployments.reserves.perPoolUsdc as string);
const perPoolStateToken = BigInt(deployments.reserves.perPoolStateToken as string);

console.log(`[retry] deployer=${deployer.address}`);

for (const [abbr, entry] of Object.entries(byState)) {
  if (entry.tokenId !== '0') {
    console.log(`[retry] ${abbr}: already has position#${entry.tokenId} — skip`);
    continue;
  }
  console.log(`[retry] ${abbr}: token0=${entry.token0} token1=${entry.token1}`);
  const pool = await waitForPoolReady(entry.token0, entry.token1);
  console.log(`[retry]   pool ready at ${pool}`);

  // amount0/amount1 mapping: whichever side is the StateToken (18 dec) takes
  // perPoolStateToken; the USDC side takes perPoolUsdc.
  const tok0Lower = entry.token0.toLowerCase();
  const usdcAddr = (deployments.contracts.MockUSDC.address as string).toLowerCase();
  const tok0IsUsdc = tok0Lower === usdcAddr;
  const amount0 = tok0IsUsdc ? perPoolUsdc : perPoolStateToken;
  const amount1 = tok0IsUsdc ? perPoolStateToken : perPoolUsdc;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mintTx = await wallet.writeContract({
    address: NPM,
    abi: npmAbi,
    functionName: 'mint',
    args: [
      {
        token0: entry.token0,
        token1: entry.token1,
        fee: FEE,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: deployer.address,
        deadline,
      },
    ],
  });
  const r = await publicClient.waitForTransactionReceipt({ hash: mintTx });
  if (r.status !== 'success') throw new Error(`${abbr} mint reverted (tx=${mintTx})`);

  let tokenId = 0n;
  let liquidity = 0n;
  let used0 = 0n;
  let used1 = 0n;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== NPM.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({ abi: npmAbi, data: log.data, topics: log.topics });
      if (parsed.eventName === 'IncreaseLiquidity') {
        const a = parsed.args as { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint };
        tokenId = a.tokenId;
        liquidity = a.liquidity;
        used0 = a.amount0;
        used1 = a.amount1;
      }
    } catch {
      // skip
    }
  }
  console.log(`[retry]   ✓ position#${tokenId} liq=${liquidity} amt0=${used0} amt1=${used1}`);

  entry.poolAddress = pool;
  entry.tokenId = tokenId.toString();
  entry.liquidity = liquidity.toString();
  entry.amount0Used = used0.toString();
  entry.amount1Used = used1.toString();
  entry.mintTx = mintTx;
}

// Also fix poolAddress for the original 2 successful entries (which got 0x0
// stored due to the same RPC stale-read bug).
for (const [abbr, entry] of Object.entries(byState)) {
  if (entry.poolAddress === ZERO_ADDRESS) {
    const pool = (await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [entry.token0, entry.token1, FEE],
    })) as Address;
    if (pool !== ZERO_ADDRESS) {
      console.log(`[retry] ${abbr}: backfilled poolAddress=${pool}`);
      entry.poolAddress = pool;
    }
  }
}

writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
console.log(`[retry] wrote ${DEPLOYMENTS_PATH}`);
console.log('[retry] ✓ done');
