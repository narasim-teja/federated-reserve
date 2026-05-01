/**
 * Phase 3 smoke test — drive a real Trading API swap end-to-end.
 *
 * MA agent buys 1 USDC worth of MAT. After the tx confirms, dump:
 *   - tx hash + Unichain Sepolia explorer link
 *   - MA's USDC balance delta  (should be ~ -1 USDC)
 *   - MA's MAT balance delta   (should be ~ +0.997 MAT @ pool-implied price)
 *
 * Run: bun run scripts/smoke-execute.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, type Address, createPublicClient, parseAbi } from 'viem';
import { SwapExecutor } from '../packages/agent/src/execute.ts';
import { getStateToken, getUsdc, loadDeployments } from '../packages/shared/src/deployments.ts';

const REPO_ROOT = join(import.meta.dir, '..');
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
const API_KEY = process.env.UNISWAP_API_KEY ?? '';
const MA_PK = process.env.WALLET_MA_PRIVATE_KEY as `0x${string}`;
if (!MA_PK) throw new Error('WALLET_MA_PRIVATE_KEY missing');

const dep = loadDeployments('unichain-sepolia');
const usdc = getUsdc(dep);
const mat = getStateToken(dep, 'MA');

console.log(`[smoke] tokenIn=USDC@${usdc.address}  tokenOut=MAT@${mat.address}`);
console.log(`[smoke] swapper=MA wallet  chain=${CHAIN_ID}`);

const erc20Abi = parseAbi(['function balanceOf(address) external view returns (uint256)']);
const publicClient = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: 'Unichain Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const,
  transport: http(RPC),
});

async function bal(token: Address, who: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
  })) as bigint;
}

const exec = new SwapExecutor({ privateKey: MA_PK, apiKey: API_KEY, chainId: CHAIN_ID, rpc: RPC });
console.log(`[smoke] MA address: ${exec.address}`);

const usdcBefore = await bal(usdc.address, exec.address);
const matBefore = await bal(mat.address, exec.address);
console.log(`[smoke] before: USDC=${usdcBefore}  MAT=${matBefore}`);

const ONE_USDC = 1_000_000n; // 6 decimals
const result = await exec.swap({
  tokenIn: usdc.address,
  tokenOut: mat.address,
  amount: ONE_USDC,
  slippageTolerancePct: 1.0,
});

console.log('');
console.log('[smoke] result:', {
  txHash: result.txHash,
  status: result.status,
  amountIn: result.amountIn.toString(),
  expectedOut: result.expectedOut.toString(),
  block: result.blockNumber.toString(),
  quoteRequestId: result.quoteRequestId,
  swapRequestId: result.swapRequestId,
});
console.log(`[smoke] explorer: https://unichain-sepolia.blockscout.com/tx/${result.txHash}`);

const usdcAfter = await bal(usdc.address, exec.address);
const matAfter = await bal(mat.address, exec.address);
console.log(`[smoke] after:  USDC=${usdcAfter}  MAT=${matAfter}`);
console.log(`[smoke] delta:  USDC=${usdcAfter - usdcBefore}  MAT=${matAfter - matBefore}`);

if (result.status !== 'success') {
  console.error('[smoke] FAIL — swap status was not success');
  process.exit(1);
}
if (matAfter - matBefore <= 0n) {
  console.error('[smoke] FAIL — MAT balance did not increase');
  process.exit(1);
}
console.log('[smoke] ✓ PASS');
