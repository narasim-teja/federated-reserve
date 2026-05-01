/**
 * Phase 3 — seed Uniswap V3 pools on Unichain Sepolia.
 *
 * For each {USDC, StateToken} pair we:
 *   1. Sort the token addresses (Uniswap V3 requires token0 < token1).
 *   2. Compute sqrtPriceX96 for an initial nominal 1:1 price (a state's
 *      treasury token roughly stables-pegged at issuance), accounting for
 *      the 6-vs-18 decimal mismatch.
 *   3. Approve both tokens to NonfungiblePositionManager (max uint256).
 *   4. Call `createAndInitializePoolIfNecessary` then `mint` with full-range
 *      ticks (lower=-887220, upper=887220 for fee tier 3000 spacing 60).
 *   5. Read the deployed pool address back from the V3 factory and append it
 *      to `contracts/deployments/unichain-sepolia.json` under `pools`.
 *
 * Run: bun run scripts/seed-pools.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------- env -------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..');
const DEPLOYMENTS_PATH = join(REPO_ROOT, 'contracts', 'deployments', 'unichain-sepolia.json');
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
if (!DEPLOYER_PK) throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing');

// ---------- Uniswap V3 addresses on Unichain Sepolia ------------------------

const NONFUNGIBLE_POSITION_MANAGER: Address = '0xB7F724d6dDDFd008eFf5cc2834edDE5F9eF0d075';
const V3_FACTORY: Address = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// 0.3% fee tier — tick spacing 60, well-routed by the Trading API CLASSIC path.
const FEE = 3000;
const TICK_SPACING = 60;
// Tick limits for spacing=60: floor(MAX_TICK / 60) * 60 = 887220.
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;

// ---------- chain client ----------------------------------------------------

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

console.log(`[seed] chain=${CHAIN_ID}  rpc=${RPC}  deployer=${deployer.address}`);

// ---------- ABIs -------------------------------------------------------------

const npmAbi = parseAbi([
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);

const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
]);

// ---------- helpers ----------------------------------------------------------

const TWO_96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Compute the sqrtPriceX96 for a 1:1 nominal initial price between a token
 * with `dec0` decimals and a token with `dec1` decimals (where token0 has
 * the lower address per Uniswap V3 ordering).
 *
 * price (token1 raw / token0 raw) for nominal 1:1 = 10^(dec1 - dec0)
 * sqrtPriceX96 = floor(sqrt(price) * 2^96)
 *
 * Cases we hit on-chain (USDC=6dec, StateToken=18dec):
 *   token0=USDC, token1=ST   →  price = 10^12, sqrt = 10^6, X96 = 10^6 << 96
 *   token0=ST,   token1=USDC →  price = 10^-12, sqrt = 10^-6, X96 = (1<<96)/10^6
 */
function sqrtPriceX96NominalOneToOne(dec0: number, dec1: number): bigint {
  const diff = dec1 - dec0;
  if (diff === 12) {
    return 1_000_000n * TWO_96;
  }
  if (diff === -12) {
    return TWO_96 / 1_000_000n;
  }
  if (diff === 0) {
    return TWO_96;
  }
  throw new Error(`unsupported decimal diff ${diff}; expected ±12 or 0`);
}

async function ensureApproval(token: Address, spender: Address, label: string): Promise<void> {
  const cur = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [deployer.address, spender],
  })) as bigint;
  if (cur >= MAX_UINT256 / 2n) {
    console.log(`[seed]   ${label} already approved`);
    return;
  }
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[seed]   ${label} approved (tx=${hash})`);
}

interface SeededPool {
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
}

async function seedPool(
  abbr: string,
  symbol: string,
  stateTokenAddr: Address,
  usdcAddr: Address,
  reserveStateToken: bigint,
  reserveUsdc: bigint,
): Promise<SeededPool> {
  const stLower = stateTokenAddr.toLowerCase() as Address;
  const usdcLower = usdcAddr.toLowerCase() as Address;
  const stIsToken0 = stLower < usdcLower;
  const token0 = stIsToken0 ? stateTokenAddr : usdcAddr;
  const token1 = stIsToken0 ? usdcAddr : stateTokenAddr;
  const dec0 = stIsToken0 ? 18 : 6;
  const dec1 = stIsToken0 ? 6 : 18;
  const amount0 = stIsToken0 ? reserveStateToken : reserveUsdc;
  const amount1 = stIsToken0 ? reserveUsdc : reserveStateToken;
  const sqrtPriceX96 = sqrtPriceX96NominalOneToOne(dec0, dec1);

  console.log(
    `[seed] ${abbr} pool: token0=${token0} (${stIsToken0 ? symbol : 'USDC'})  token1=${token1} (${stIsToken0 ? 'USDC' : symbol})`,
  );

  // 1. createAndInitializePoolIfNecessary
  const initTx = await wallet.writeContract({
    address: NONFUNGIBLE_POSITION_MANAGER,
    abi: npmAbi,
    functionName: 'createAndInitializePoolIfNecessary',
    args: [token0, token1, FEE, sqrtPriceX96],
  });
  await publicClient.waitForTransactionReceipt({ hash: initTx });
  console.log(`[seed]   pool init/create tx=${initTx}`);

  // 2. confirm pool address from factory
  const poolAddress = (await publicClient.readContract({
    address: V3_FACTORY,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [token0, token1, FEE],
  })) as Address;
  console.log(`[seed]   pool address: ${poolAddress}`);

  // 3. mint LP position
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mintTx = await wallet.writeContract({
    address: NONFUNGIBLE_POSITION_MANAGER,
    abi: npmAbi,
    functionName: 'mint',
    args: [
      {
        token0,
        token1,
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
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTx });
  console.log(`[seed]   mint tx=${mintTx}  status=${mintReceipt.status}`);

  // 4. extract tokenId + liquidity from IncreaseLiquidity event
  let tokenId = 0n;
  let liquidity = 0n;
  let used0 = 0n;
  let used1 = 0n;
  for (const log of mintReceipt.logs) {
    if (log.address.toLowerCase() !== NONFUNGIBLE_POSITION_MANAGER.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({ abi: npmAbi, data: log.data, topics: log.topics });
      if (parsed.eventName === 'IncreaseLiquidity') {
        const a = parsed.args as {
          tokenId: bigint;
          liquidity: bigint;
          amount0: bigint;
          amount1: bigint;
        };
        tokenId = a.tokenId;
        liquidity = a.liquidity;
        used0 = a.amount0;
        used1 = a.amount1;
      }
    } catch {
      // not an event we care about
    }
  }
  console.log(
    `[seed]   ✓ position#${tokenId}  liquidity=${liquidity}  amount0Used=${used0}  amount1Used=${used1}`,
  );

  return {
    state: abbr,
    pair: stIsToken0 ? `${symbol}-USDC` : `USDC-${symbol}`,
    token0,
    token1,
    fee: FEE,
    sqrtPriceX96: sqrtPriceX96.toString(),
    poolAddress,
    tokenId: tokenId.toString(),
    liquidity: liquidity.toString(),
    amount0Used: used0.toString(),
    amount1Used: used1.toString(),
    initTx,
    mintTx,
  };
}

// ---------- main -------------------------------------------------------------

if (!existsSync(DEPLOYMENTS_PATH)) {
  throw new Error(`deployments file missing: ${DEPLOYMENTS_PATH}`);
}
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const usdcAddr = deployments.contracts.MockUSDC.address as Address;
const stateTokens = deployments.contracts.StateTokens as Record<
  string,
  { address: Address; symbol: string }
>;
const perPoolUsdc = BigInt(deployments.reserves.perPoolUsdc as string);
const perPoolStateToken = BigInt(deployments.reserves.perPoolStateToken as string);

console.log(
  `[seed] reserves per pool: ${(perPoolUsdc / 10n ** 6n).toString()} USDC + ${(perPoolStateToken / 10n ** 18n).toString()} StateToken`,
);

// pre-flight balance check
{
  const usdcBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [deployer.address],
  })) as bigint;
  console.log(`[seed] deployer USDC balance: ${(usdcBal / 10n ** 6n).toString()} USDC`);
  const need = perPoolUsdc * BigInt(Object.keys(stateTokens).length);
  if (usdcBal < need) {
    throw new Error(`deployer needs ${need} USDC for LP, has ${usdcBal}`);
  }
}

// approve USDC + each StateToken to NPM (one-time, idempotent)
console.log('[seed] approvals…');
await ensureApproval(usdcAddr, NONFUNGIBLE_POSITION_MANAGER, 'USDC');
for (const [abbr, info] of Object.entries(stateTokens)) {
  await ensureApproval(info.address, NONFUNGIBLE_POSITION_MANAGER, `${abbr} (${info.symbol})`);
}

// seed each pool
const seeded: SeededPool[] = [];
for (const [abbr, info] of Object.entries(stateTokens)) {
  const r = await seedPool(
    abbr,
    info.symbol,
    info.address,
    usdcAddr,
    perPoolStateToken,
    perPoolUsdc,
  );
  seeded.push(r);
}

// persist
deployments.pools = {
  v3Factory: V3_FACTORY,
  nonfungiblePositionManager: NONFUNGIBLE_POSITION_MANAGER,
  fee: FEE,
  tickLower: TICK_LOWER,
  tickUpper: TICK_UPPER,
  byState: Object.fromEntries(seeded.map((p) => [p.state, p])),
};
deployments.seededAt = new Date().toISOString();
writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
console.log(`[seed] wrote pools to ${DEPLOYMENTS_PATH}`);
console.log('[seed] ✓ done');
