/**
 * Read-only sanity check for the Phase 5 onchain wiring.
 *
 * For each state with a deployment record:
 *   1. Derive the wallet address from WALLET_<ABBR>_PRIVATE_KEY.
 *   2. Compare it to contracts.StateTokens.<ABBR>.agent (the "official" agent
 *      address baked into deployments at seed time).
 *   3. Hit Unichain Sepolia RPC for USDC + state-token + native + bond
 *      balances using the same multicall path the running agent uses.
 *   4. Print a one-line status per agent and a final tally.
 *
 * Spends no gas; only RPC reads. Safe to run repeatedly.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { ChainReader } from '../packages/agent/src/chain-reader.ts';
import { OgReader } from '../packages/agent/src/og-reader.ts';
import { loadDeployments } from '../packages/shared/src/deployments.ts';

// Bun automatically loads `.env`, `.env.local`, and `.env.<NODE_ENV>` from the
// project root, so explicit dotenv is unnecessary.

const ABBRS = ['MA', 'CA', 'TX', 'NY', 'FL', 'IL', 'WA', 'AK'] as const;

interface Row {
  abbr: string;
  derived: string;
  expected: string;
  match: boolean;
  usdc: string;
  stateToken: string;
  native: string;
  bonds: number;
  totalUsd: number;
  ratio: number;
  error?: string;
  ogNative?: string;
  ogTokenURI?: string;
  ogOwnerOk?: boolean;
}

const dep = loadDeployments('unichain-sepolia');
const rpc = process.env.UNICHAIN_SEPOLIA_RPC ?? 'https://sepolia.unichain.org';
const chainId = Number(process.env.UNICHAIN_SEPOLIA_CHAIN_ID ?? 1301);
const ogRpc = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const ogChainId = Number(process.env.OG_CHAIN_ID ?? 16602);

console.log(`[verify] reading from ${rpc} (chain ${chainId})`);
console.log(`[verify] og rpc: ${ogRpc} (chain ${ogChainId})`);

const rows: Row[] = [];

for (const abbr of ABBRS) {
  const expected = dep.contracts.StateTokens[abbr]?.agent ?? '';
  const pk = process.env[`WALLET_${abbr}_PRIVATE_KEY`];
  if (!pk || !pk.startsWith('0x') || pk === '0xPLACEHOLDER') {
    rows.push({
      abbr,
      derived: '<missing>',
      expected,
      match: false,
      usdc: '0',
      stateToken: '0',
      native: '0',
      bonds: 0,
      totalUsd: 0,
      ratio: 0,
      error: 'no private key',
    });
    continue;
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const derived = account.address;
  const match = derived.toLowerCase() === expected.toLowerCase();

  const reader = new ChainReader({ rpc, chainId, walletAddress: derived, stateAbbr: abbr });
  const og = new OgReader({
    rpc: ogRpc,
    chainId: ogChainId,
    walletAddress: derived,
    stateAbbr: abbr,
    explorerBase: process.env.OG_EXPLORER_BASE_URL,
    storageExplorerBase: process.env.OG_STORAGE_EXPLORER_BASE_URL,
  });

  try {
    const [bal, ogStat] = await Promise.all([reader.refresh(), og.refresh()]);
    if (!bal) {
      rows.push({
        abbr,
        derived,
        expected,
        match,
        usdc: '0',
        stateToken: '0',
        native: '0',
        bonds: 0,
        totalUsd: 0,
        ratio: 0,
        error: 'chain read returned null',
      });
      continue;
    }
    rows.push({
      abbr,
      derived,
      expected,
      match,
      usdc: bal.usdcBalance,
      stateToken: bal.stateToken ? `${bal.stateToken.balance} ${bal.stateToken.symbol}` : '—',
      native: bal.nativeBalance,
      bonds: bal.bonds.length,
      totalUsd: bal.totalNotionalUsd,
      ratio: bal.liquidReserveRatio,
      ogNative: ogStat?.nativeBalance,
      ogTokenURI: ogStat?.inft?.onchainUri,
      ogOwnerOk: ogStat?.inft?.ownerMatches,
    });
  } catch (err) {
    rows.push({
      abbr,
      derived,
      expected,
      match,
      usdc: '0',
      stateToken: '0',
      native: '0',
      bonds: 0,
      totalUsd: 0,
      ratio: 0,
      error: (err as Error).message.slice(0, 200),
    });
  }
}

console.log('\nABBR | wallet match | USDC          | state token             | ETH       | bonds | total $    | ratio  | 0G gas    | iNFT owner');
console.log('-----+--------------+---------------+-------------------------+-----------+-------+------------+--------+-----------+-----------');
for (const r of rows) {
  const matchTag = r.match ? '✓' : '✗';
  const ratioPct = `${(r.ratio * 100).toFixed(1)}%`;
  const ogOwner = r.ogOwnerOk == null ? '—' : r.ogOwnerOk ? '✓' : '✗ MISMATCH';
  console.log(
    `${r.abbr.padEnd(4)} |      ${matchTag}       | ${r.usdc.slice(0, 13).padEnd(13)} | ${r.stateToken.slice(0, 23).padEnd(23)} | ${r.native.slice(0, 9).padEnd(9)} | ${String(r.bonds).padStart(5)} | ${('$' + r.totalUsd.toFixed(0)).padStart(10)} | ${ratioPct.padStart(6)} | ${(r.ogNative ?? '—').slice(0, 9).padEnd(9)} | ${ogOwner}${r.error ? '  err=' + r.error : ''}`,
  );
}

const mismatches = rows.filter((r) => !r.match);
const errors = rows.filter((r) => r.error);
console.log('');
console.log(`wallets matching deployments: ${rows.length - mismatches.length}/${rows.length}`);
console.log(`successful chain reads:       ${rows.length - errors.length}/${rows.length}`);
if (mismatches.length > 0) {
  for (const m of mismatches) {
    console.log(`  MISMATCH ${m.abbr}: derived=${m.derived} expected=${m.expected}`);
  }
}
if (errors.length > 0) {
  for (const e of errors) {
    console.log(`  ERROR ${e.abbr}: ${e.error}`);
  }
}

process.exit(errors.length > 0 ? 1 : 0);
