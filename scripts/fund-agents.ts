/**
 * Distribute deployer's testnet funds to the 8 state-agent wallets.
 *
 *   Unichain Sepolia: top each agent to UNICHAIN_TARGET_ETH if currently below
 *   0G Galileo:       top each agent to OG_TARGET if currently below
 *
 * Skips agents already at or above target. Skips entirely if the deployer
 * doesn't have enough balance to cover the run + a gas reserve. Idempotent:
 * re-run anytime; a satisfied agent is a no-op.
 *
 * Usage:
 *   bun run scripts/fund-agents.ts                 # both chains
 *   bun run scripts/fund-agents.ts --chain unichain
 *   bun run scripts/fund-agents.ts --chain og
 *   bun run scripts/fund-agents.ts --dry-run
 *
 * Spends real testnet gas. Targets are conservative.
 */

import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatEther,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadDeployments } from '../packages/shared/src/deployments.ts';

const ABBRS = ['MA', 'CA', 'TX', 'NY', 'FL', 'IL', 'WA', 'AK'] as const;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const chainArgIdx = args.indexOf('--chain');
const chainFilter = chainArgIdx >= 0 ? args[chainArgIdx + 1] : 'all';

// Conservative defaults — caller can override via env.
const UNICHAIN_TARGET = parseEther(process.env.UNICHAIN_TARGET_ETH ?? '0.1');
const OG_TARGET = parseEther(process.env.OG_TARGET ?? '1.0');
const UNICHAIN_GAS_RESERVE = parseEther('0.05'); // leave for future deploys
const OG_GAS_RESERVE = parseEther('1.0');

const deployerPk = process.env.WALLET_DEPLOYER_PRIVATE_KEY;
if (!deployerPk || !deployerPk.startsWith('0x') || deployerPk === '0xPLACEHOLDER') {
  throw new Error('WALLET_DEPLOYER_PRIVATE_KEY missing/placeholder');
}
const deployer = privateKeyToAccount(deployerPk as Hex);
console.log(`deployer: ${deployer.address}`);

// Resolve agent addresses up front (matches contracts.StateTokens.<ABBR>.agent).
const dep = loadDeployments('unichain-sepolia');
const recipients: Array<{ abbr: string; address: Address }> = [];
for (const abbr of ABBRS) {
  const entry = dep.contracts.StateTokens[abbr];
  if (!entry) {
    console.warn(`skip ${abbr}: no StateToken entry in deployments`);
    continue;
  }
  recipients.push({ abbr, address: entry.agent as Address });
}

if (chainFilter === 'all' || chainFilter === 'unichain') {
  await fundChain({
    label: 'Unichain Sepolia',
    rpc: process.env.UNICHAIN_SEPOLIA_RPC ?? 'https://sepolia.unichain.org',
    chainId: Number(process.env.UNICHAIN_SEPOLIA_CHAIN_ID ?? 1301),
    target: UNICHAIN_TARGET,
    gasReserve: UNICHAIN_GAS_RESERVE,
    nativeSymbol: 'ETH',
  });
}

if (chainFilter === 'all' || chainFilter === 'og') {
  await fundChain({
    label: '0G Galileo',
    rpc: process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
    chainId: Number(process.env.OG_CHAIN_ID ?? 16602),
    target: OG_TARGET,
    gasReserve: OG_GAS_RESERVE,
    nativeSymbol: '0G',
  });
}

interface FundChainArgs {
  label: string;
  rpc: string;
  chainId: number;
  target: bigint;
  gasReserve: bigint;
  nativeSymbol: string;
}

async function fundChain(args: FundChainArgs): Promise<void> {
  const { label, rpc, chainId, target, gasReserve, nativeSymbol } = args;
  console.log(`\n=== ${label} (chain ${chainId}) ===`);
  const chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpc) });

  const deployerBal = await publicClient.getBalance({ address: deployer.address });
  console.log(`deployer balance: ${formatEther(deployerBal)} ${nativeSymbol}`);

  // Compute top-up plan.
  const plan: Array<{ abbr: string; address: Address; current: bigint; topUp: bigint }> = [];
  for (const r of recipients) {
    const bal = await publicClient.getBalance({ address: r.address });
    const need = bal >= target ? 0n : target - bal;
    plan.push({ abbr: r.abbr, address: r.address, current: bal, topUp: need });
  }

  const totalNeed = plan.reduce((s, p) => s + p.topUp, 0n);
  console.log(`plan: total top-up = ${formatEther(totalNeed)} ${nativeSymbol}`);
  for (const p of plan) {
    if (p.topUp === 0n) {
      console.log(
        `  ${p.abbr.padEnd(2)}  ${p.address}  current=${formatEther(p.current)} ${nativeSymbol}  → satisfied`,
      );
    } else {
      console.log(
        `  ${p.abbr.padEnd(2)}  ${p.address}  current=${formatEther(p.current)}  send ${formatEther(p.topUp)} ${nativeSymbol}`,
      );
    }
  }

  if (totalNeed === 0n) {
    console.log('all agents already at or above target — nothing to send');
    return;
  }

  if (deployerBal < totalNeed + gasReserve) {
    console.error(
      `INSUFFICIENT: deployer has ${formatEther(deployerBal)} ${nativeSymbol}, ` +
        `need ${formatEther(totalNeed + gasReserve)} (incl. ${formatEther(gasReserve)} gas reserve)`,
    );
    return;
  }

  if (dryRun) {
    console.log('--dry-run: not sending');
    return;
  }

  for (const p of plan) {
    if (p.topUp === 0n) continue;
    process.stdout.write(`  sending ${formatEther(p.topUp)} ${nativeSymbol} → ${p.abbr} ... `);
    try {
      const hash = await walletClient.sendTransaction({
        account: deployer,
        chain: null,
        to: p.address,
        value: p.topUp,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`tx=${hash.slice(0, 12)}… status=${receipt.status} block=${receipt.blockNumber}`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  const after = await publicClient.getBalance({ address: deployer.address });
  console.log(`deployer balance after: ${formatEther(after)} ${nativeSymbol}`);
}
