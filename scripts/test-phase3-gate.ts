/**
 * Phase 3 gate test — onchain settlement of an A2A bilateral swap.
 *
 * Flow:
 *   1. Read MA + CA pubkeys from their AXL nodes.
 *   2. Snapshot MA + CA balances of {USDC, MAT, CAT} on Unichain Sepolia.
 *   3. CA (initiator) sends `proposal` to MA via AXL `/a2a/{ma_key}`.
 *   4. MA (responder, OpenRouter-driven with deterministic fallback) returns `counter` and
 *      task transitions to `input-required`.
 *   5. CA sends `accept` with the countered terms.
 *   6. MA's executor:
 *        - fires its responder leg: USDC → CAT (Trading API)
 *        - emits `Completed` with `settlement.legs.responder` populated.
 *   7. The test driver (acting as the initiator's process) fires CA's leg:
 *      USDC → MAT (Trading API), via a SwapExecutor keyed to CA's PK.
 *   8. Re-read balances; assert:
 *        - settlement.legs.responder.status === 'success'
 *        - both legs have valid 0x… tx hashes
 *        - MA.USDC decreased; MA.CAT increased
 *        - CA.USDC decreased; CA.MAT increased
 *
 * Run:  ./scripts/test-phase3-gate.sh
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, type Address, createPublicClient, parseAbi } from 'viem';
import { SwapExecutor } from '../packages/agent/src/execute.ts';
import {
  type ContractDeployments,
  getStateToken,
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
const CA_API = 'http://127.0.0.1:9012';
const MA_API = 'http://127.0.0.1:9002';

if (!CA_PK) throw new Error('WALLET_CA_PRIVATE_KEY missing');

// Trade parameters — small enough to leave plenty of headroom in the pools
// AND in each agent's USDC balance, but large enough that the Trading API
// produces a real CLASSIC route with non-zero output.
const TRADE_USDC = 100_000_000n; // 100 USDC base units
const TRADE_STATE_TOKEN_NOMINAL = 50n * 10n ** 18n; // favorable 2 USDC/token pilot target

// ---------- helpers ----------

function fail(label: string, msg: string): never {
  console.error(`[phase3] ✗ ${label}: ${msg}`);
  process.exit(1);
}
function ok(label: string): void {
  console.log(`[phase3] ✓ ${label}`);
}

async function getPubkey(api: string): Promise<string> {
  const res = await fetch(`${api}/topology`);
  if (!res.ok) throw new Error(`AXL ${api}/topology HTTP ${res.status}`);
  const j = (await res.json()) as { our_public_key: string };
  return j.our_public_key;
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

// Read balance with retry-until-changed to defeat Unichain Sepolia RPC stale
// reads (same gotcha that hit pool seeding + the smoke test).
async function balAfterChange(
  token: Address,
  who: Address,
  baseline: bigint,
  label: string,
): Promise<bigint> {
  for (let i = 0; i < 12; i++) {
    const v = await bal(token, who);
    if (v !== baseline) return v;
    await Bun.sleep(1000);
  }
  console.warn(`[phase3] balance for ${label} never moved off ${baseline} (12s) — using last read`);
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
  error?: { code: number; message: string };
}

function findDataPayload(res: AxlA2aResponse): Record<string, unknown> | undefined {
  const msgParts = res.result?.status?.message?.parts ?? [];
  for (const p of msgParts) {
    if (p.kind === 'data' && p.data) return p.data;
  }
  for (const a of res.result?.artifacts ?? []) {
    for (const p of a.parts ?? []) {
      if (p.kind === 'data' && p.data) return p.data;
    }
  }
  return undefined;
}

async function sendA2a(fromApi: string, toPubkey: string, body: unknown): Promise<AxlA2aResponse> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${fromApi}/a2a/${toPubkey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return (await res.json()) as AxlA2aResponse;
    }
    const text = await res.text();
    console.log(`[phase3]   A2A attempt ${attempt}: HTTP ${res.status} ${text.slice(0, 120)}`);
    await Bun.sleep(2000);
  }
  throw new Error(`A2A send to ${toPubkey} never returned 200`);
}

// ---------- main ----------

console.log('[phase3] starting Phase 3 gate test');
const dep: ContractDeployments = loadDeployments('unichain-sepolia');
const usdc = getUsdc(dep);
const matInfo = getStateToken(dep, 'MA');
const catInfo = getStateToken(dep, 'CA');
const ma = matInfo.address as Address;
const cat = catInfo.address as Address;

const MA_ADDR = process.env.WALLET_MA_ADDRESS as Address;
const CA_ADDR = process.env.WALLET_CA_ADDRESS as Address;
if (!MA_ADDR || !CA_ADDR) fail('env', 'WALLET_MA_ADDRESS or WALLET_CA_ADDRESS missing');

console.log(`[phase3] tokens: USDC=${usdc.address}  MAT=${ma}  CAT=${cat}`);

// 1. peer pubkeys
const maKey = await getPubkey(MA_API);
const caKey = await getPubkey(CA_API);
console.log(`[phase3] MA key=${maKey.slice(0, 16)}…  CA key=${caKey.slice(0, 16)}…`);
ok('mesh reachable, both pubkeys resolved');

// 2. snapshot pre-trade balances
const before = {
  ma: {
    usdc: await bal(usdc.address as Address, MA_ADDR),
    mat: await bal(ma, MA_ADDR),
    cat: await bal(cat, MA_ADDR),
  },
  ca: {
    usdc: await bal(usdc.address as Address, CA_ADDR),
    mat: await bal(ma, CA_ADDR),
    cat: await bal(cat, CA_ADDR),
  },
};
console.log(
  `[phase3] before: MA{USDC=${before.ma.usdc} MAT=${before.ma.mat} CAT=${before.ma.cat}} CA{USDC=${before.ca.usdc} CAT=${before.ca.cat} MAT=${before.ca.mat}}`,
);

// 3. round 1: CA → MA proposal
const round1 = {
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
            kind: 'proposal',
            initiator_fips: 6,
            give: { asset: 'USDC', amount: TRADE_USDC.toString() },
            receive: { asset: 'MAT', amount: TRADE_STATE_TOKEN_NOMINAL.toString() },
            rationale:
              'Phase 3 gate: CA pays 100 USDC for a small pilot MA exposure; counter instead of rejecting if the terms need adjustment.',
          },
        },
      ],
    },
  },
};
console.log('[phase3] round 1: CA → MA proposal');
const r1 = await sendA2a(CA_API, maKey, round1);
const r1State = r1.result?.status?.state;
const taskId = r1.result?.id;
const counterPayload = findDataPayload(r1);
console.log(
  `[phase3]   r1 state=${r1State} task=${taskId} counter.kind=${counterPayload?.kind} counter.give.amount=${(counterPayload as { give?: { amount?: string } } | undefined)?.give?.amount}`,
);
if (r1State !== 'input-required') fail('round 1', `expected input-required, got ${r1State}`);
if (counterPayload?.kind !== 'counter')
  fail('round 1', `expected counter, got ${counterPayload?.kind}`);
const counterGiveAmount = (counterPayload as { give: { amount: string } }).give.amount;
ok('round 1: input-required + counter received');

// 4. round 2: CA accepts
const round2 = {
  jsonrpc: '2.0',
  id: 2,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: randomUUID(),
      taskId,
      parts: [
        {
          kind: 'data',
          data: {
            kind: 'accept',
            by_fips: 6,
            agreed_give: { asset: 'USDC', amount: TRADE_USDC.toString() },
            agreed_receive: { asset: 'MAT', amount: counterGiveAmount },
          },
        },
      ],
    },
  },
};
console.log('[phase3] round 2: CA → MA accept');
const r2 = await sendA2a(CA_API, maKey, round2);
const r2State = r2.result?.status?.state;
const settlement = findDataPayload(r2) as
  | undefined
  | {
      kind: string;
      rounds?: number;
      legs?: {
        initiator: unknown;
        responder?: {
          tx_hash?: string;
          status?: string;
          token_in_address?: string;
          token_out_address?: string;
          amount_in?: string;
        } | null;
      };
      tx_hash?: string | null;
    };
console.log(
  `[phase3]   r2 state=${r2State} settlement.kind=${settlement?.kind} rounds=${settlement?.rounds} responder_tx=${settlement?.legs?.responder?.tx_hash}`,
);
if (r2State !== 'completed') fail('round 2', `expected completed, got ${r2State}`);
if (settlement?.kind !== 'settlement')
  fail('round 2', `expected settlement, got ${settlement?.kind}`);
ok('round 2: completed with settlement payload');

// 5. assert responder leg
const respLeg = settlement.legs?.responder;
if (!respLeg) fail('responder leg', 'missing — MA executor did not fire');
if (respLeg.status !== 'success') fail('responder leg', `status=${respLeg.status}`);
if (!respLeg.tx_hash || !respLeg.tx_hash.startsWith('0x')) {
  fail('responder leg', `bad tx_hash=${respLeg.tx_hash}`);
}
console.log(
  `[phase3]   responder leg tx: https://unichain-sepolia.blockscout.com/tx/${respLeg.tx_hash}`,
);
ok(`responder leg: tx=${respLeg.tx_hash}`);

// 6. fire initiator leg from the test driver (CA's wallet)
console.log('[phase3] firing initiator (CA) leg: USDC → MAT');
const exec = new SwapExecutor({ privateKey: CA_PK, apiKey: API_KEY, chainId: CHAIN_ID, rpc: RPC });
const initResult = await exec.swap({
  tokenIn: usdc.address as Address,
  tokenOut: ma,
  amount: TRADE_USDC,
  slippageTolerancePct: 1.0,
});
console.log(
  `[phase3]   initiator leg tx: https://unichain-sepolia.blockscout.com/tx/${initResult.txHash}`,
);
ok(`initiator leg: status=${initResult.status} tx=${initResult.txHash}`);
if (initResult.status !== 'success') fail('initiator leg', `status=${initResult.status}`);

// 7. confirm balance deltas
console.log('[phase3] confirming on-chain balance deltas (RPC may lag a few seconds)');
const after = {
  ma: {
    usdc: await balAfterChange(usdc.address as Address, MA_ADDR, before.ma.usdc, 'MA.USDC'),
    cat: await balAfterChange(cat, MA_ADDR, before.ma.cat, 'MA.CAT'),
  },
  ca: {
    usdc: await balAfterChange(usdc.address as Address, CA_ADDR, before.ca.usdc, 'CA.USDC'),
    mat: await balAfterChange(ma, CA_ADDR, before.ca.mat, 'CA.MAT'),
  },
};
const dMaUsdc = after.ma.usdc - before.ma.usdc;
const dMaCat = after.ma.cat - before.ma.cat;
const dCaUsdc = after.ca.usdc - before.ca.usdc;
const dCaMat = after.ca.mat - before.ca.mat;
console.log(`[phase3]   MA delta: USDC=${dMaUsdc}  CAT=${dMaCat}`);
console.log(`[phase3]   CA delta: USDC=${dCaUsdc}  MAT=${dCaMat}`);

if (dMaUsdc >= 0n) fail('MA.USDC delta', `expected decrease, got ${dMaUsdc}`);
if (dMaCat <= 0n) fail('MA.CAT delta', `expected increase, got ${dMaCat}`);
if (dCaUsdc >= 0n) fail('CA.USDC delta', `expected decrease, got ${dCaUsdc}`);
if (dCaMat <= 0n) fail('CA.MAT delta', `expected increase, got ${dCaMat}`);
ok('both wallets rebalanced (USDC out, peer-state-token in)');

console.log('');
console.log('[phase3] ✓ PASS');
console.log(
  `         responder (MA): https://unichain-sepolia.blockscout.com/tx/${respLeg.tx_hash}`,
);
console.log(
  `         initiator (CA): https://unichain-sepolia.blockscout.com/tx/${initResult.txHash}`,
);
