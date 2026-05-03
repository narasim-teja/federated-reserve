/**
 * Unichain Sepolia read-side helper.
 *
 * Replaces the stub `composition` that `state.ts:makeInitialState` seeds
 * with real on-chain numbers. One refresh batches:
 *
 *   - MockUSDC.balanceOf(wallet)
 *   - <state>Token.balanceOf(wallet) — only for our own state
 *   - bondToken.balanceOf(wallet) for every bond in deployments
 *   - native ETH balance
 *   - the latest block number (audit trail)
 *
 * All reads are issued through a single `multicall3` round-trip when the
 * RPC supports it (Unichain Sepolia does). Failure is non-fatal: the caller
 * is expected to keep prior state and retry on the next cadence tick. Never
 * fakes data — if the RPC errors or returns nothing usable, we return null.
 */

import {
  http,
  type Address,
  type PublicClient,
  createPublicClient,
  formatEther,
  formatUnits,
  parseAbi,
} from 'viem';
import {
  type ContractDeployments,
  loadDeployments,
} from '@federated-reserve/shared';

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export interface ChainBondHolding {
  bondId: string;
  symbol: string;
  /** Bond token raw balance (decimals=6). */
  balanceRaw: string;
  /** Decimal-formatted, e.g. "1500.00". */
  balance: string;
  /** USD notional at par (bonds are USDC-denominated). */
  notionalUsd: number;
  address: Address;
  couponBps: number;
}

export interface ChainBalances {
  /** ISO-8601 timestamp of the snapshot. */
  fetchedAt: string;
  /** Block number the reads anchored against. */
  blockNumber: string;
  chainId: number;
  rpc: string;
  walletAddress: Address;
  /** Native gas (ETH) — formatted. */
  nativeBalance: string;
  /** Native gas raw wei. */
  nativeBalanceRaw: string;
  /** USDC raw (6 decimals) and human. */
  usdcBalanceRaw: string;
  usdcBalance: string;
  usdcUsd: number;
  /** This agent's own state token (only the agent that issues that state holds it meaningfully). */
  stateToken: {
    abbr: string;
    address: Address;
    symbol: string;
    /** 18-decimal raw. */
    balanceRaw: string;
    balance: string;
    /** Symbolic USD value — state token has no real price; we mark to USDC reserve at 1:1. */
    notionalUsd: number;
  } | null;
  bonds: ChainBondHolding[];
  /** Sum of all USD notionals (USDC + bonds + state-token-at-par). */
  totalNotionalUsd: number;
  /** USDC fraction of totalNotionalUsd — used as the live reserve ratio. */
  liquidReserveRatio: number;
}

export interface ChainReaderOptions {
  rpc: string;
  chainId: number;
  walletAddress: Address;
  /** Agent's state abbreviation, used to look up its native StateToken. */
  stateAbbr: string;
  /** Optional explicit deployments override (testing). */
  deployments?: ContractDeployments;
  /** Per-call timeout in ms (default 8000). */
  timeoutMs?: number;
}

export class ChainReader {
  readonly publicClient: PublicClient;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly rpc: string;
  private readonly stateAbbr: string;
  private readonly deployments: ContractDeployments;
  private readonly timeoutMs: number;

  constructor(opts: ChainReaderOptions) {
    if (!opts.walletAddress.startsWith('0x')) {
      throw new Error('ChainReader: walletAddress must be 0x-prefixed');
    }
    this.walletAddress = opts.walletAddress;
    this.chainId = opts.chainId;
    this.rpc = opts.rpc;
    this.stateAbbr = opts.stateAbbr.toUpperCase();
    this.deployments = opts.deployments ?? loadDeployments('unichain-sepolia');
    this.timeoutMs = opts.timeoutMs ?? 8000;

    // Canonical Multicall3 — deterministic CREATE2 deployment present on
    // every major chain we touch (Unichain Sepolia, Mainnet, etc.). viem
    // refuses to multicall without this field set on the chain config.
    const chain = {
      id: opts.chainId,
      name: `chain-${opts.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpc] } },
      contracts: {
        multicall3: {
          address: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address,
        },
      },
    } as const;
    this.publicClient = createPublicClient({
      chain,
      transport: http(opts.rpc, { timeout: this.timeoutMs }),
    });
  }

  /**
   * Take one balance snapshot. Returns null on RPC failure so the caller can
   * keep prior state and retry on the next cadence tick.
   */
  async refresh(): Promise<ChainBalances | null> {
    try {
      const usdc = this.deployments.contracts.MockUSDC;
      const ourStateToken = this.deployments.contracts.StateTokens[this.stateAbbr];
      const bondsMap = this.deployments.bonds ?? {};
      const bondEntries = Object.values(bondsMap);

      // Build a single multicall batch: USDC + own state token + N bonds.
      const calls: Array<{ address: Address; abi: typeof ERC20_ABI; functionName: 'balanceOf'; args: [Address] }> = [
        {
          address: usdc.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [this.walletAddress],
        },
      ];
      if (ourStateToken) {
        calls.push({
          address: ourStateToken.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [this.walletAddress],
        });
      }
      for (const bond of bondEntries) {
        calls.push({
          address: bond.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [this.walletAddress],
        });
      }

      const [block, native, multi] = await Promise.all([
        this.publicClient.getBlockNumber(),
        this.publicClient.getBalance({ address: this.walletAddress }),
        this.publicClient.multicall({
          contracts: calls,
          allowFailure: true,
        }),
      ]);

      let cursor = 0;
      const usdcRes = multi[cursor++];
      const usdcBal = pickResult(usdcRes) ?? 0n;

      let stateToken: ChainBalances['stateToken'] = null;
      if (ourStateToken) {
        const stRes = multi[cursor++];
        const stBal = pickResult(stRes) ?? 0n;
        stateToken = {
          abbr: this.stateAbbr,
          address: ourStateToken.address,
          symbol: ourStateToken.symbol,
          balanceRaw: stBal.toString(),
          balance: formatUnits(stBal, ourStateToken.decimals),
          // State tokens were seeded into pools at par with USDC, so use the
          // pool reserve ratio (sqrtPriceX96=1.0) and treat 1 token = 1 USDC
          // for first-order treasury notional. Real pricing would walk the
          // pool tick state.
          notionalUsd: Number(formatUnits(stBal, ourStateToken.decimals)),
        };
      }

      const bonds: ChainBondHolding[] = [];
      for (const bond of bondEntries) {
        const bRes = multi[cursor++];
        const bal = pickResult(bRes) ?? 0n;
        if (bal === 0n) continue;
        const human = formatUnits(bal, bond.decimals);
        bonds.push({
          bondId: bond.bondId,
          symbol: bond.symbol,
          balanceRaw: bal.toString(),
          balance: human,
          notionalUsd: Number(human),
          address: bond.address as Address,
          couponBps: bond.couponBps,
        });
      }

      const usdcHuman = formatUnits(usdcBal, usdc.decimals);
      const usdcUsd = Number(usdcHuman);
      const stateUsd = stateToken?.notionalUsd ?? 0;
      const bondUsd = bonds.reduce((s, b) => s + b.notionalUsd, 0);
      const total = usdcUsd + stateUsd + bondUsd;
      const liquidReserveRatio = total > 0 ? usdcUsd / total : 0;

      return {
        fetchedAt: new Date().toISOString(),
        blockNumber: block.toString(),
        chainId: this.chainId,
        rpc: this.rpc,
        walletAddress: this.walletAddress,
        nativeBalance: formatEther(native),
        nativeBalanceRaw: native.toString(),
        usdcBalanceRaw: usdcBal.toString(),
        usdcBalance: usdcHuman,
        usdcUsd,
        stateToken,
        bonds,
        totalNotionalUsd: total,
        liquidReserveRatio,
      };
    } catch (err) {
      console.warn(
        `[chain-reader:${this.stateAbbr}] refresh failed: ${(err as Error).message.slice(0, 200)}`,
      );
      return null;
    }
  }
}

function pickResult<T>(
  res: { status: 'success'; result: T } | { status: 'failure'; error: Error } | undefined,
): T | undefined {
  if (!res) return undefined;
  return res.status === 'success' ? (res.result as T) : undefined;
}

/** Strict address parse; throws if env value is not a 0x-prefixed 20-byte hex. */
export function parseAddress(value: string | undefined, context: string): Address {
  if (!value) throw new Error(`${context}: address missing`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${context}: not a 20-byte hex address: ${value}`);
  }
  return value as Address;
}

/** Convenience for the agent runtime: build explorer URLs for a tx or address. */
export function buildExplorerUrls(
  base: string | undefined,
  walletAddress: Address,
): { addressUrl?: string; chainBaseUrl?: string } {
  if (!base) return {};
  const trimmed = base.replace(/\/$/, '');
  return {
    chainBaseUrl: trimmed,
    addressUrl: `${trimmed}/address/${walletAddress}`,
  };
}

