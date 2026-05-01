/**
 * Typed accessor for Phase 3 contract deployments.
 *
 * The Phase 3 deploy + seed scripts persist
 * `contracts/deployments/unichain-sepolia.json` with: MockUSDC + 5
 * StateTokens + 1 INFT7857 + 5 Uniswap V3 pools. This module is the single
 * place agents (and tests) load that file from. Loaded lazily and cached.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Hex0x = `0x${string}`;

export interface ContractDeployments {
  chain: string;
  chainId: number;
  rpc: string;
  deployer: Hex0x;
  deployedAt: string;
  contracts: {
    MockUSDC: { address: Hex0x; decimals: 6 };
    StateTokens: Record<
      string, // state abbr (MA, CA, …)
      {
        address: Hex0x;
        fips: number;
        name: string;
        symbol: string;
        decimals: 18;
        agent: Hex0x;
      }
    >;
    INFT7857: { address: Hex0x };
  };
  reserves: {
    perPoolUsdc: string;
    perPoolStateToken: string;
  };
  pools?: {
    v3Factory: Hex0x;
    nonfungiblePositionManager: Hex0x;
    fee: number;
    tickLower: number;
    tickUpper: number;
    byState: Record<
      string,
      {
        state: string;
        pair: string;
        token0: Hex0x;
        token1: Hex0x;
        fee: number;
        sqrtPriceX96: string;
        poolAddress: Hex0x;
        tokenId: string;
        liquidity: string;
        amount0Used: string;
        amount1Used: string;
        initTx: Hex0x;
        mintTx: Hex0x;
      }
    >;
  };
  seededAt?: string;
  bonds?: Record<
    string, // bondId, e.g. "NY-2030-Q1-A"
    {
      bondId: string;
      address: Hex0x;
      issuerFips: number;
      issuerAddr: Hex0x;
      couponBps: number;
      maturity: string;
      principalUsdcBase: string;
      symbol: string;
      name: string;
      decimals: 6;
      deployTx: Hex0x;
    }
  >;
}

/**
 * Walk up from the calling module toward the repo root and locate
 * `contracts/deployments/<chain>.json`. The mesh runner sets cwd to
 * `packages/agent/`, so a static path won't do; we resolve from a known
 * marker (the `contracts` directory).
 */
function findDeploymentsFile(chain: string): string {
  // Allow override (used in tests).
  const env = process.env.DEPLOYMENTS_PATH;
  if (env) return resolve(env);

  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'contracts', 'deployments', `${chain}.json`);
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // not here, walk up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `deployments file for chain "${chain}" not found walking up from ${process.cwd()}`,
  );
}

let cached: ContractDeployments | undefined;

export function loadDeployments(chain = 'unichain-sepolia'): ContractDeployments {
  if (cached && cached.chain === chain) return cached;
  const path = findDeploymentsFile(chain);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ContractDeployments;
  cached = parsed;
  return parsed;
}

/** Address book lookups used by the swap executor. */

export interface TokenInfo {
  abbr: 'USDC' | string;
  address: Hex0x;
  decimals: number;
  symbol: string;
}

export function getUsdc(d: ContractDeployments): TokenInfo {
  return {
    abbr: 'USDC',
    address: d.contracts.MockUSDC.address,
    decimals: d.contracts.MockUSDC.decimals,
    symbol: 'USDC',
  };
}

export function getStateToken(d: ContractDeployments, abbr: string): TokenInfo {
  const e = d.contracts.StateTokens[abbr.toUpperCase()];
  if (!e) throw new Error(`no StateToken for ${abbr} in deployments`);
  return { abbr: abbr.toUpperCase(), address: e.address, decimals: e.decimals, symbol: e.symbol };
}

/** Resolve a free-text asset id (e.g. "USDC", "MAT", "MA-TOKEN") to a TokenInfo. */
export function resolveAsset(d: ContractDeployments, assetId: string): TokenInfo {
  const id = assetId.toUpperCase();
  if (id === 'USDC') return getUsdc(d);
  // strip "T" suffix or "-TOKEN" suffix
  const base = id.replace(/-TOKEN$/, '').replace(/T$/, '');
  if (d.contracts.StateTokens[base]) return getStateToken(d, base);
  if (d.contracts.StateTokens[id]) return getStateToken(d, id);
  throw new Error(
    `cannot resolve asset "${assetId}" — known: USDC, ${Object.keys(d.contracts.StateTokens).join(', ')}`,
  );
}

/** Look up a deployed bond by id; returns undefined if Phase 3 bond deploys
 *  haven't run yet, or the bondId is unknown. */
export function getBond(
  d: ContractDeployments,
  bondId: string,
): NonNullable<ContractDeployments['bonds']>[string] | undefined {
  return d.bonds?.[bondId];
}
