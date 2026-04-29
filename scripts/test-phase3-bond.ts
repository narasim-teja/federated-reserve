/**
 * Phase 3 bond-auction gate test — primary issuance settlement.
 *
 * Flow:
 *   1. Read CA + MA pubkeys from their AXL nodes.
 *   2. Snapshot CA's USDC + bond-token balance, MA's USDC balance.
 *   3. CA (bidder) sends a `bond-auction` bid to MA (issuer) via AXL/A2A
 *      with bid_yield_bps=400 (≤ MA's 800 bps deterministic threshold).
 *   4. MA's executor:
 *        - decides "awarded" (deterministic fallback or reasoner)
 *        - calls BondToken.mint(CA, principal) on the deployed contract
 *        - returns BondAward with mint_tx_hash + bond_token_address.
 *   5. The driver (acting on CA's behalf) calls USDC.transfer(MA, principal).
 *   6. Verify on-chain:
 *        - CA holds `principal` of BondToken
 *        - CA's USDC dropped by `principal`
 *        - MA's USDC rose by `principal`
 *
 * Run:  ./scripts/test-phase3-bond.sh
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, createPublicClient, http, parseAbi } from 'viem';
import { SwapExecutor } from '../packages/agent/src/execute.ts';
import {
  type ContractDeployments,
  getBond,
  getUsdc,
  loadDeployments,
} from '../packages/shared/src/deployments.ts';

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
const CA_PK = process.env.WALLET_CA_PRIVATE_KEY as `0x${string}`;
const CA_API = 'http://127.0.0.1:9012'; // bidder originates here
const MA_API = 'http://127.0.0.1:9002'; // issuer (bootstrap)
if (!CA_PK) throw new Error('WALLET_CA_PRIVATE_KEY missing');

const BOND_ID = 'MA-2030-Q1-A';
// Bid for the full principal of the demo bond ($1,000 face value).
const BID_PRINCIPAL_USD = 1000;
// Phase 4 introduced a credit-rating floor for bond eval (MA at BBB → 550bps
// floor). We bid 600bps to stay above floor while still being attractive to
// the issuer. The Phase 3 test originally used 400bps under a deterministic
// 800bps ceiling; updated for the Phase 4 evaluator without changing what's
// being tested (single-bid primary issuance settlement).
const BID_YIELD_BPS = 600;

// ---------- helpers ----------

function fail(label: string, msg: string): never {
  console.error(`[bond-gate] ✗ ${label}: ${msg}`);
  process.exit(1);
}
function ok(label: string): void {
  console.log(`[bond-gate] ✓ ${label}`);
}

async function getPubkey(api: string): Promise<string> {
  const res = await fetch(`${api}/topology`);
  if (!res.ok) throw new Error(`AXL ${api}/topology HTTP ${res.status}`);
  return ((await res.json()) as { our_public_key: string }).our_public_key;
}

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
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
async function balAfterChange(token: Address, who: Address, baseline: bigint, label: string): Promise<bigint> {
  for (let i = 0; i < 12; i++) {
    const v = await bal(token, who);
    if (v !== baseline) return v;
    await Bun.sleep(1000);
  }
  console.warn(`[bond-gate] balance for ${label} never moved off ${baseline} (12s) — using last read`);
  return baseline;
}

interface AxlA2aResponse {
  result?: {
    id?: string;
    status?: {
      state?: string;
      message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> };
    };
    artifacts?: Array<{ parts?: Array<{ kind: string; data?: Record<string, unknown> }> }>;
  };
}
function findDataPayload(res: AxlA2aResponse): Record<string, unknown> | undefined {
  const msgParts = res.result?.status?.message?.parts ?? [];
  for (const p of msgParts) if (p.kind === 'data' && p.data) return p.data;
  for (const a of res.result?.artifacts ?? []) for (const p of a.parts ?? []) if (p.kind === 'data' && p.data) return p.data;
  return undefined;
}
async function sendA2a(fromApi: string, toPubkey: string, body: unknown): Promise<AxlA2aResponse> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${fromApi}/a2a/${toPubkey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as AxlA2aResponse;
    console.log(`[bond-gate]   A2A attempt ${attempt}: HTTP ${res.status}`);
    await Bun.sleep(2000);
  }
  throw new Error(`A2A send to ${toPubkey} never returned 200`);
}

// ---------- main ----------

console.log('[bond-gate] starting Phase 3 bond gate test');
const dep: ContractDeployments = loadDeployments('unichain-sepolia');
const usdc = getUsdc(dep);
const bond = getBond(dep, BOND_ID);
if (!bond) fail('setup', `bond ${BOND_ID} not in deployments — run scripts/deploy-bond.ts first`);

const CA_ADDR = process.env.WALLET_CA_ADDRESS as Address;
const MA_ADDR = process.env.WALLET_MA_ADDRESS as Address;
if (!MA_ADDR || !CA_ADDR) fail('env', 'WALLET_MA_ADDRESS or WALLET_CA_ADDRESS missing');

console.log(
  `[bond-gate] bond ${bond.bondId} @ ${bond.address}  issuer=MA ${bond.issuerAddr}  principal=${bond.principalUsdcBase}`,
);

// 1. peer pubkeys
const caKey = await getPubkey(CA_API);
const maKey = await getPubkey(MA_API);
console.log(`[bond-gate] CA key=${caKey.slice(0, 16)}…  MA key=${maKey.slice(0, 16)}…`);
ok('mesh reachable, both pubkeys resolved');

// 2. snapshot
const before = {
  ca: { usdc: await bal(usdc.address as Address, CA_ADDR), bond: await bal(bond.address as Address, CA_ADDR) },
  ma: { usdc: await bal(usdc.address as Address, MA_ADDR) },
};
console.log(
  `[bond-gate] before: CA{USDC=${before.ca.usdc} ${bond.symbol}=${before.ca.bond}} MA{USDC=${before.ma.usdc}}`,
);

// 3. CA → MA bid
const bidPayload = {
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: randomUUID(),
      parts: [
        {
          kind: 'data',
          data: {
            skill: 'bond-auction',
            issuer_fips: bond.issuerFips,
            bidder_fips: 6, // CA
            bond_id: bond.bondId,
            principal_usd: BID_PRINCIPAL_USD,
            bid_yield_bps: BID_YIELD_BPS,
            rationale: 'CA bidding on MA 4.25% 2030 — Northeast diversification',
          },
        },
      ],
    },
  },
};
console.log(`[bond-gate] CA → MA bid: ${BID_PRINCIPAL_USD} @ ${BID_YIELD_BPS}bps`);
const r1 = await sendA2a(CA_API, maKey, bidPayload);
const r1State = r1.result?.status?.state;
const award = findDataPayload(r1) as
  | undefined
  | {
      kind?: string;
      bond_id?: string;
      yield_bps?: number;
      bond_token_address?: string | null;
      mint_tx_hash?: string | null;
      principal_usdc_base?: string | null;
    };
console.log(
  `[bond-gate]   r1 state=${r1State} award.kind=${award?.kind} mint_tx=${award?.mint_tx_hash} bond=${award?.bond_token_address}`,
);
if (r1State !== 'completed') fail('round 1', `expected completed, got ${r1State}`);
if (award?.kind !== 'awarded') fail('round 1', `expected awarded, got ${award?.kind}`);
if (!award.mint_tx_hash || !award.mint_tx_hash.startsWith('0x')) {
  fail('mint settlement', `bad mint_tx_hash=${award.mint_tx_hash}`);
}
if (!award.bond_token_address || award.bond_token_address.toLowerCase() !== bond.address.toLowerCase()) {
  fail('mint settlement', `bond address mismatch: ${award.bond_token_address}`);
}
console.log(
  `[bond-gate]   issuer mint tx: https://unichain-sepolia.blockscout.com/tx/${award.mint_tx_hash}`,
);
ok('issuer (NY) minted BondToken to bidder (MA)');

// 4. bidder pays issuer
const principal = BigInt(award.principal_usdc_base ?? bond.principalUsdcBase);
console.log(`[bond-gate] CA → MA USDC payment: ${principal} base units`);
const exec = new SwapExecutor({ privateKey: CA_PK, apiKey: API_KEY, chainId: CHAIN_ID, rpc: RPC });
const pay = await exec.payIssuer(usdc.address as Address, MA_ADDR, principal);
console.log(`[bond-gate]   pay tx: https://unichain-sepolia.blockscout.com/tx/${pay.txHash}`);
ok(`bidder (CA) paid issuer (MA): tx=${pay.txHash}`);
if (pay.status !== 'success') fail('pay leg', `status=${pay.status}`);

// 5. confirm balance deltas
console.log('[bond-gate] confirming on-chain balance deltas');
const after = {
  ca: {
    usdc: await balAfterChange(usdc.address as Address, CA_ADDR, before.ca.usdc, 'CA.USDC'),
    bond: await balAfterChange(bond.address as Address, CA_ADDR, before.ca.bond, `CA.${bond.symbol}`),
  },
  ma: {
    usdc: await balAfterChange(usdc.address as Address, MA_ADDR, before.ma.usdc, 'MA.USDC'),
  },
};
const dCaUsdc = after.ca.usdc - before.ca.usdc;
const dCaBond = after.ca.bond - before.ca.bond;
const dMaUsdc = after.ma.usdc - before.ma.usdc;
console.log(`[bond-gate]   CA delta: USDC=${dCaUsdc}  ${bond.symbol}=${dCaBond}`);
console.log(`[bond-gate]   MA delta: USDC=${dMaUsdc}`);
if (dCaUsdc !== -principal) fail('CA.USDC delta', `expected ${-principal}, got ${dCaUsdc}`);
if (dCaBond !== principal) fail(`CA.${bond.symbol} delta`, `expected ${principal}, got ${dCaBond}`);
if (dMaUsdc !== principal) fail('MA.USDC delta', `expected +${principal}, got ${dMaUsdc}`);
ok('settled: CA holds bond face value, MA received principal in USDC');

console.log('');
console.log('[bond-gate] ✓ PASS');
console.log(`         issuer mint:  https://unichain-sepolia.blockscout.com/tx/${award.mint_tx_hash}`);
console.log(`         bidder pay:   https://unichain-sepolia.blockscout.com/tx/${pay.txHash}`);
