/**
 * viem-shaped INFT7857 wrappers — mint / updateMetadata / transfer.
 *
 * The 0G testnet RPC sometimes 404s on `eth_getTransactionReceipt` for ~10s
 * after submission, which trips viem's default `waitForTransactionReceipt`.
 * `waitForReceipt` here polls manually with retries.
 */

import {
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const INFT7857_ABI = [
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'encryptedURI_', type: 'string' },
      { name: 'metadataHash_', type: 'bytes32' },
      { name: 'sealedKey_', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateMetadata',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
      { name: 'newHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'newSealedKey', type: 'bytes' },
      { name: 'proof', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'ownerOf',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'encryptedURI',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'metadataHash',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'sealedKey',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'MetadataUpdated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'newHash', type: 'bytes32', indexed: false },
      { name: 'newURI', type: 'string', indexed: false },
    ],
  },
] as const;

export interface OgChainConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
  inftAddress: Address;
  explorerBase?: string;
}

export class INFTContract {
  readonly address: Address;
  readonly explorer: string;
  private wallet: WalletClient;
  private pub: PublicClient;
  private account;

  constructor(cfg: OgChainConfig) {
    this.address = cfg.inftAddress;
    this.explorer = (cfg.explorerBase ?? 'https://chainscan-galileo.0g.ai').replace(/\/$/, '');
    this.account = privateKeyToAccount(cfg.privateKey);
    const chain = {
      id: cfg.chainId,
      name: '0G-Galileo-Testnet',
      nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    } as const;
    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(cfg.rpcUrl) });
  }

  get sender(): Address {
    return this.account.address;
  }

  async waitForReceipt(hash: Hex, timeoutMs = 90_000): Promise<{ status: 'success' | 'reverted' }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await this.pub.getTransactionReceipt({ hash });
        return { status: r.status };
      } catch {
        await new Promise((res) => setTimeout(res, 3_000));
      }
    }
    throw new Error(`receipt not found within ${timeoutMs}ms for ${hash}`);
  }

  async mint(args: {
    to: Address;
    tokenId: bigint;
    encryptedURI: string;
    metadataHash: Hex;
    sealedKey: Hex;
  }): Promise<{ tx: Hex }> {
    const tx = await this.wallet.writeContract({
      account: this.account,
      chain: this.wallet.chain,
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'mint',
      args: [args.to, args.tokenId, args.encryptedURI, args.metadataHash, args.sealedKey],
    });
    const r = await this.waitForReceipt(tx);
    if (r.status !== 'success') throw new Error(`mint reverted (tx=${tx})`);
    return { tx };
  }

  async updateMetadata(args: { tokenId: bigint; newURI: string; newHash: Hex }): Promise<{ tx: Hex }> {
    const tx = await this.wallet.writeContract({
      account: this.account,
      chain: this.wallet.chain,
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'updateMetadata',
      args: [args.tokenId, args.newURI, args.newHash],
    });
    const r = await this.waitForReceipt(tx);
    if (r.status !== 'success') throw new Error(`updateMetadata reverted (tx=${tx})`);
    return { tx };
  }

  async transferIntelligence(args: {
    from: Address;
    to: Address;
    tokenId: bigint;
    newSealedKey: Hex;
    proof: Hex;
  }): Promise<{ tx: Hex }> {
    const tx = await this.wallet.writeContract({
      account: this.account,
      chain: this.wallet.chain,
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'transfer',
      args: [args.from, args.to, args.tokenId, args.newSealedKey, args.proof],
    });
    const r = await this.waitForReceipt(tx);
    if (r.status !== 'success') throw new Error(`transfer reverted (tx=${tx})`);
    return { tx };
  }

  async ownerOf(tokenId: bigint): Promise<Address> {
    return (await this.pub.readContract({
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as Address;
  }

  async encryptedURI(tokenId: bigint): Promise<string> {
    return (await this.pub.readContract({
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'encryptedURI',
      args: [tokenId],
    })) as string;
  }

  async metadataHash(tokenId: bigint): Promise<Hex> {
    return (await this.pub.readContract({
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'metadataHash',
      args: [tokenId],
    })) as Hex;
  }

  async sealedKey(tokenId: bigint): Promise<Hex> {
    return (await this.pub.readContract({
      address: this.address,
      abi: INFT7857_ABI,
      functionName: 'sealedKey',
      args: [tokenId],
    })) as Hex;
  }

  txUrl(tx: Hex): string {
    return `${this.explorer}/tx/${tx}`;
  }
  addressUrl(addr: Address): string {
    return `${this.explorer}/address/${addr}`;
  }
}
