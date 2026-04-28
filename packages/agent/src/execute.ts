/**
 * Phase 3 — agent-side swap executor backed by the Uniswap Trading API.
 *
 * Flow per swap:
 *   1. POST /v1/check_approval  → if non-null, submit ERC-20 approve(Permit2).
 *   2. POST /v1/quote           → CLASSIC route + Permit2 EIP-712 typed data.
 *   3. signTypedData(permitData)→ Permit2 PermitSingle signature.
 *   4. POST /v1/swap            → returns ready-to-sign tx calldata.
 *   5. wallet.sendRawTransaction → submit; waitForReceipt; extract tx hash.
 *
 * Each agent process instantiates exactly one SwapExecutor in `index.ts`,
 * keyed to its own `WALLET_${ABBR}_PRIVATE_KEY`. The bilateral-swap A2A
 * executor calls `swap()` once per leg when negotiation completes.
 *
 * IMPORTANT: this module is **Trading-API-only**. We do not have a fallback
 * path to direct Universal Router calls — using the Trading API is the
 * Uniswap-track qualifying requirement, so any failure surfaces as a real
 * failure and goes into FEEDBACK.md.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

const TRADING_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';

// ---------- API response shapes (minimal — pull only the fields we use) ----

interface ApprovalCalldata {
  to: Address;
  from: Address;
  data: Hex;
  value: string;
  chainId: number;
}

interface CheckApprovalResponse {
  approval: ApprovalCalldata | null;
  // some chains also return `cancel` for revoke-then-approve; we ignore
}

interface PermitDataValues {
  details: {
    token: Address;
    amount: string;
    expiration: string;
    nonce: string;
  };
  spender: Address;
  sigDeadline: string;
}

interface PermitData {
  domain: {
    name: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  values: PermitDataValues;
}

interface ClassicQuote {
  routing: 'CLASSIC' | 'WRAP' | 'UNWRAP';
  requestId: string;
  permitData: PermitData | null;
  permitTransaction: unknown | null;
  quote: {
    chainId: number;
    swapper: Address;
    tradeType: 'EXACT_INPUT' | 'EXACT_OUTPUT';
    route: unknown[][];
    input: { amount: string; token: Address };
    output: { amount: string; token: Address };
    slippage: number;
    gasFee?: string;
    gasFeeUSD?: string;
    gasUseEstimate?: string;
  };
}

interface SwapResponse {
  requestId: string;
  swap: {
    to: Address;
    from: Address;
    data: Hex;
    value: string;
    chainId: number;
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
}

// ---------- helpers ---------------------------------------------------------

function isHex0x(s: string): s is Hex {
  return /^0x[0-9a-fA-F]*$/.test(s);
}

function bigintFromMaybe(s: string | undefined): bigint | undefined {
  if (!s) return undefined;
  return BigInt(s);
}

async function postJson<T>(path: string, body: unknown, apiKey: string): Promise<T> {
  const url = `${TRADING_API_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-universal-router-version': '2.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Uniswap ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Uniswap ${path} bad JSON: ${(err as Error).message}: ${text.slice(0, 200)}`);
  }
}

// ---------- SwapExecutor ----------------------------------------------------

export interface SwapExecutorConfig {
  /** 0x-prefixed private key for the executing wallet. */
  privateKey: Hex;
  /** Trading API key (Uniswap Developer Portal). */
  apiKey: string;
  /** Numeric chain id (1301 for Unichain Sepolia). */
  chainId: number;
  /** RPC URL. */
  rpc: string;
}

export interface SwapInput {
  tokenIn: Address;
  tokenOut: Address;
  /**
   * Raw amount in `tokenIn` base units (6 decimals for USDC, 18 for
   * StateTokens). Pass as bigint or numeric string.
   */
  amount: bigint | string;
  /** Slippage tolerance in percent (0-100). Defaults to 0.5. */
  slippageTolerancePct?: number;
}

export interface SwapResult {
  txHash: Hex;
  amountIn: bigint;
  /** Quote-reported expected output (pre-slippage). */
  expectedOut: bigint;
  /** Address that was credited. */
  recipient: Address;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  /** Trading API requestId for the /quote call (audit trail). */
  quoteRequestId: string;
  /** Trading API requestId for the /swap call. */
  swapRequestId: string;
}

export class SwapExecutor {
  readonly account: PrivateKeyAccount;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly chainId: number;
  readonly apiKey: string;

  constructor(cfg: SwapExecutorConfig) {
    if (!cfg.privateKey || !cfg.privateKey.startsWith('0x')) {
      throw new Error('SwapExecutor: bad privateKey');
    }
    if (!cfg.apiKey) throw new Error('SwapExecutor: missing apiKey (UNISWAP_API_KEY)');
    this.account = privateKeyToAccount(cfg.privateKey);
    this.chainId = cfg.chainId;
    this.apiKey = cfg.apiKey;
    const chain = {
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    } as const;
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpc) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(cfg.rpc) });
  }

  /** The address this executor signs with. */
  get address(): Address {
    return this.account.address;
  }

  /** Step 1: check whether the swapper has approved Permit2 for `tokenIn`. */
  async checkApproval(tokenIn: Address, amount: bigint): Promise<ApprovalCalldata | null> {
    const res = await postJson<CheckApprovalResponse>(
      '/check_approval',
      {
        walletAddress: this.account.address,
        token: tokenIn,
        amount: amount.toString(),
        chainId: this.chainId,
      },
      this.apiKey,
    );
    return res.approval ?? null;
  }

  /** Step 2: fetch the executable quote. */
  async quote(input: SwapInput): Promise<ClassicQuote> {
    const body = {
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amount: typeof input.amount === 'bigint' ? input.amount.toString() : input.amount,
      type: 'EXACT_INPUT',
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      swapper: this.account.address,
      slippageTolerance: input.slippageTolerancePct ?? 0.5,
    };
    const q = await postJson<ClassicQuote>('/quote', body, this.apiKey);
    if (q.routing !== 'CLASSIC' && q.routing !== 'WRAP' && q.routing !== 'UNWRAP') {
      throw new Error(
        `unexpected routing "${q.routing}" — Phase 3 only handles CLASSIC on Unichain Sepolia`,
      );
    }
    return q;
  }

  /** Step 3a: submit the ERC-20 approve(Permit2) tx. */
  async submitApproval(approval: ApprovalCalldata): Promise<Hex> {
    if (approval.chainId !== this.chainId) {
      throw new Error(`approval chainId mismatch: ${approval.chainId} vs ${this.chainId}`);
    }
    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: null,
      to: approval.to,
      data: approval.data,
      value: BigInt(approval.value),
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`approval reverted (tx=${hash})`);
    return hash;
  }

  /** Step 3b: sign the Permit2 PermitSingle EIP-712 typed data from the quote. */
  async signPermit(permitData: PermitData): Promise<Hex> {
    return this.account.signTypedData({
      domain: permitData.domain,
      types: permitData.types as never,
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: permitData.values.details.token,
          amount: BigInt(permitData.values.details.amount),
          expiration: Number(permitData.values.details.expiration),
          nonce: Number(permitData.values.details.nonce),
        },
        spender: permitData.values.spender,
        sigDeadline: BigInt(permitData.values.sigDeadline),
      },
    } as never);
  }

  /** Step 4: convert the quote (+ signature) into ready-to-broadcast calldata. */
  async fetchSwap(quote: ClassicQuote, signature: Hex | undefined): Promise<SwapResponse> {
    // Spread the quote response, strip the null/local-only fields, attach
    // signature + permitData per CLASSIC rules.
    const { permitData, permitTransaction, ...cleanQuote } = quote as ClassicQuote & {
      permitTransaction: unknown | null;
    };
    void permitTransaction;
    const body: Record<string, unknown> = { ...cleanQuote };
    if (signature && permitData) {
      body.signature = signature;
      body.permitData = permitData;
    }
    return postJson<SwapResponse>('/swap', body, this.apiKey);
  }

  /** Step 5: submit the swap tx and wait for confirmation. */
  async submitSwap(swap: SwapResponse['swap']): Promise<{ txHash: Hex; blockNumber: bigint; status: 'success' | 'reverted' }> {
    if (swap.chainId !== this.chainId) {
      throw new Error(`swap chainId mismatch: ${swap.chainId} vs ${this.chainId}`);
    }
    if (!swap.data || swap.data === '0x' || !isHex0x(swap.data)) {
      throw new Error('swap.data missing or invalid — quote may have expired');
    }
    // Don't trust the API-returned gasLimit blindly — on Unichain Sepolia
    // we observed CLASSIC routes returning a gasLimit ~95k that was tight
    // enough for the SwapRouter shell to start the swap but not enough for
    // the inner ERC-20 transfer to recipient, which then OutOfGas'd inside
    // the V3 pool with revert reason "TF". Estimating ourselves and adding
    // a 25% safety buffer is robust across pool depths and recipient code
    // sizes (since safeTransfer's gas cost depends on whether the recipient
    // is a contract).
    const apiGasLimit = bigintFromMaybe(swap.gasLimit);
    let estimated: bigint;
    try {
      estimated = await this.publicClient.estimateGas({
        account: this.account,
        to: swap.to,
        data: swap.data,
        value: BigInt(swap.value),
      });
    } catch (err) {
      // If estimation reverts, surface the API-reported gasLimit (or a
      // safe default) so the caller can still try; revert detail surfaces
      // in the receipt status.
      console.warn(`[swap] estimateGas failed: ${(err as Error).message.slice(0, 200)}`);
      estimated = apiGasLimit ?? 500_000n;
    }
    const gas = (estimated * 125n) / 100n; // 25% headroom
    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: null,
      to: swap.to,
      data: swap.data,
      value: BigInt(swap.value),
      gas,
      maxFeePerGas: bigintFromMaybe(swap.maxFeePerGas),
      maxPriorityFeePerGas: bigintFromMaybe(swap.maxPriorityFeePerGas),
    });
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, blockNumber: r.blockNumber, status: r.status };
  }

  /** Convenience: end-to-end swap, returning a structured result for the
   * A2A executor to splice into the settlement payload. */
  async swap(input: SwapInput): Promise<SwapResult> {
    const amount = typeof input.amount === 'bigint' ? input.amount : BigInt(input.amount);

    // 1. Approval (idempotent; the API returns null when already approved).
    const approval = await this.checkApproval(input.tokenIn, amount);
    if (approval) {
      await this.submitApproval(approval);
    }

    // 2. Quote.
    const q = await this.quote({ ...input, amount });
    const expectedOut = BigInt(q.quote.output.amount);

    // 3. Sign permit (CLASSIC always returns permitData on first authorization).
    const signature = q.permitData ? await this.signPermit(q.permitData) : undefined;

    // 4. Build swap calldata.
    const swap = await this.fetchSwap(q, signature);

    // 5. Submit + confirm.
    const sub = await this.submitSwap(swap.swap);

    return {
      txHash: sub.txHash,
      amountIn: amount,
      expectedOut,
      recipient: this.account.address,
      blockNumber: sub.blockNumber,
      status: sub.status,
      quoteRequestId: q.requestId,
      swapRequestId: swap.requestId,
    };
  }
}
