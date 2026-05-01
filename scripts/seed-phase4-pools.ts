/**
 * Phase 4 — seed the 3 missing V3 pools (USDC × {IL, WA, AK} StateTokens).
 *
 * Idempotent: skips any state whose pool entry already has a non-zero
 * tokenId.
 *
 * Two-step pattern (handles the Unichain Sepolia RPC stale-read gotcha
 * documented in Phase 3 FEEDBACK.md):
 *   1. createAndInitializePoolIfNecessary
 *   2. Poll factory.getPool + pool.slot0().sqrtPriceX96 until non-zero
 *      (typically 1-5s; up to 30 attempts at 2s each)
 *   3. Mint full-range LP from the deployer
 *
 * Run: bun run scripts/seed-phase4-pools.ts
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

const PHASE4_ABBRS: ReadonlyArray<'IL' | 'WA' | 'AK'> = ['IL', 'WA', 'AK'];

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
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);
const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);
const poolAbi = parseAbi([
  'function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]);

const TWO_96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

function sqrtPriceX96NominalOneToOne(dec0: number, dec1: number): bigint {
  const diff = dec1 - dec0;
  if (diff === 12) return 1_000_000n * TWO_96;
  if (diff === -12) return TWO_96 / 1_000_000n;
  if (diff === 0) return TWO_96;
  throw new Error(`unsupported decimal diff ${diff}`);
}

async function ensureApproval(token: Address, spender: Address, label: string): Promise<void> {
  const cur = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [deployer.address, spender],
  })) as bigint;
  if (cur >= MAX_UINT256 / 2n) {
    console.log(`[p4-seed]   ${label} already approved`);
    return;
  }
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[p4-seed]   ${label} approved`);
}

async function waitForPoolReady(token0: Address, token1: Address): Promise<Address> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const pool = (await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [token0, token1, FEE],
    })) as Address;
    if (pool !== ZERO_ADDRESS) {
      const slot0 = (await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'slot0',
      })) as readonly [bigint, number, number, number, number, number, boolean];
      if (slot0[0] > 0n) return pool;
    }
    console.log(`[p4-seed]   pool not ready (attempt ${attempt}); waiting 2s…`);
    await Bun.sleep(2000);
  }
  throw new Error(`pool ${token0}/${token1} never became ready`);
}

if (!existsSync(DEPLOYMENTS_PATH)) throw new Error('deployments file missing');
const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as {
  contracts: {
    MockUSDC: { address: Address; decimals: number };
    StateTokens: Record<string, { address: Address; symbol: string }>;
  };
  reserves: { perPoolUsdc: string; perPoolStateToken: string };
  pools?: {
    v3Factory: Address;
    nonfungiblePositionManager: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    byState: Record<
      string,
      {
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
    >;
  };
};

const usdcAddr = deployments.contracts.MockUSDC.address;
const perPoolUsdc = BigInt(deployments.reserves.perPoolUsdc);
const perPoolStateToken = BigInt(deployments.reserves.perPoolStateToken);

if (!deployments.pools) {
  throw new Error('Phase 3 pools.byState not found — run scripts/seed-pools.ts first');
}

console.log(`[p4-seed] deployer=${deployer.address}`);

// Approvals (one-time, idempotent).
await ensureApproval(usdcAddr, NPM, 'USDC');
for (const abbr of PHASE4_ABBRS) {
  const t = deployments.contracts.StateTokens[abbr];
  if (!t) {
    console.warn(
      `[p4-seed]   ${abbr} StateToken missing — run scripts/deploy-phase4-onchain.ts first`,
    );
    continue;
  }
  await ensureApproval(t.address, NPM, `${abbr} (${t.symbol})`);
}

// Per-state seed.
for (const abbr of PHASE4_ABBRS) {
  const existing = deployments.pools.byState[abbr];
  if (existing && existing.tokenId !== '0') {
    console.log(`[p4-seed] ${abbr}: pool position#${existing.tokenId} already seeded — skip`);
    continue;
  }

  const t = deployments.contracts.StateTokens[abbr];
  if (!t) {
    console.warn(`[p4-seed] ${abbr}: StateToken not in deployments — skip`);
    continue;
  }
  const stateTokenAddr = t.address;

  // Sort token0 < token1 (Uniswap V3 invariant).
  const stLower = stateTokenAddr.toLowerCase() as Address;
  const usdcLower = usdcAddr.toLowerCase() as Address;
  const stIsToken0 = stLower < usdcLower;
  const token0 = stIsToken0 ? stateTokenAddr : usdcAddr;
  const token1 = stIsToken0 ? usdcAddr : stateTokenAddr;
  const dec0 = stIsToken0 ? 18 : 6;
  const dec1 = stIsToken0 ? 6 : 18;
  const amount0 = stIsToken0 ? perPoolStateToken : perPoolUsdc;
  const amount1 = stIsToken0 ? perPoolUsdc : perPoolStateToken;
  const sqrtPriceX96 = sqrtPriceX96NominalOneToOne(dec0, dec1);

  console.log(
    `[p4-seed] ${abbr}: token0=${token0}  token1=${token1}  pair=${stIsToken0 ? `${t.symbol}-USDC` : `USDC-${t.symbol}`}`,
  );

  // Step 1: init.
  const initTx = await wallet.writeContract({
    address: NPM,
    abi: npmAbi,
    functionName: 'createAndInitializePoolIfNecessary',
    args: [token0, token1, FEE, sqrtPriceX96],
  });
  await publicClient.waitForTransactionReceipt({ hash: initTx });
  console.log(`[p4-seed]   init tx=${initTx}`);

  // Step 2: wait for pool to be observable + initialized.
  const poolAddress = await waitForPoolReady(token0, token1);
  console.log(`[p4-seed]   pool address: ${poolAddress}`);

  // Step 3: mint LP.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mintTx = await wallet.writeContract({
    address: NPM,
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
      // skip
    }
  }
  console.log(`[p4-seed]   ✓ position#${tokenId} liq=${liquidity}`);

  deployments.pools.byState[abbr] = {
    state: abbr,
    pair: stIsToken0 ? `${t.symbol}-USDC` : `USDC-${t.symbol}`,
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

  // Persist incrementally so a mid-run failure doesn't lose progress.
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
}

console.log(`[p4-seed] wrote ${DEPLOYMENTS_PATH}`);
console.log('[p4-seed] ✓ done');
