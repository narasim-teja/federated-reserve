/**
 * 0G Galileo read-side helper.
 *
 * Surface what the dashboard needs to convince a human (and the judges) that
 * 0G is wired in:
 *
 *   - native 0G balance for the agent's wallet
 *   - INFT7857.tokenURI(tokenId) so we can display the most recent anchor URI
 *     and confirm it matches what the local anchor pipeline last emitted
 *   - INFT7857.ownerOf(tokenId) for sanity (catches lost-NFT bugs early)
 *   - latest block number on Galileo
 *
 * Like ChainReader, this is non-fatal: any RPC error returns null and the
 * caller keeps prior state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  http,
  type Address,
  type PublicClient,
  createPublicClient,
  formatEther,
  parseAbi,
} from 'viem';

const INFT_ABI = parseAbi([
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

interface OgInftRecord {
  tokenId?: string;
  owner_address?: string;
  encrypted_uri?: string;
  root_hash?: string;
  mint_tx?: string;
  minted_at?: string;
}

interface OgDeploymentsFile {
  chainId?: number;
  rpc?: string;
  explorer?: string;
  contracts?: { INFT7857?: { address: string } };
  iNFTs?: Record<string, OgInftRecord>;
}

export interface OgStatus {
  fetchedAt: string;
  blockNumber: string;
  chainId: number;
  rpc: string;
  walletAddress: Address;
  /** Native 0G gas — formatted (18 decimals). */
  nativeBalance: string;
  nativeBalanceRaw: string;
  /** iNFT data, when this state has one minted. */
  inft: {
    tokenId: string;
    contract: Address;
    /** Owner the chain reports right now. */
    onchainOwner: Address;
    /** Owner from the deployments manifest at mint time. */
    expectedOwner: Address;
    /** Most recent anchor URI from the chain (matches OgStorage rootHashToUri). */
    onchainUri: string;
    /** Mint-time URI from the deployments manifest. */
    initialUri: string;
    rootHash: string;
    mintTx: string;
    explorerTokenUrl?: string;
    explorerStorageUrl?: string;
    /** True iff the on-chain owner equals the expected owner. */
    ownerMatches: boolean;
  } | null;
}

export interface OgReaderOptions {
  rpc: string;
  chainId: number;
  walletAddress: Address;
  stateAbbr: string;
  /** Optional override for the deployments file path (testing). */
  deploymentsPath?: string;
  explorerBase?: string;
  storageExplorerBase?: string;
  timeoutMs?: number;
}

export class OgReader {
  readonly publicClient: PublicClient;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly rpc: string;
  private readonly stateAbbr: string;
  private readonly inftAddress: Address | null;
  private readonly tokenId: bigint | null;
  private readonly inftRecord: OgInftRecord | null;
  private readonly explorerBase: string;
  private readonly storageExplorerBase: string;
  private readonly timeoutMs: number;

  constructor(opts: OgReaderOptions) {
    this.walletAddress = opts.walletAddress;
    this.chainId = opts.chainId;
    this.rpc = opts.rpc;
    this.stateAbbr = opts.stateAbbr.toUpperCase();
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.explorerBase = (opts.explorerBase ?? 'https://chainscan-galileo.0g.ai').replace(/\/$/, '');
    this.storageExplorerBase = (
      opts.storageExplorerBase ?? 'https://storagescan-galileo.0g.ai'
    ).replace(/\/$/, '');

    const dep = loadOgDeployments(opts.deploymentsPath);
    this.inftAddress = (dep?.contracts?.INFT7857?.address ?? null) as Address | null;
    const inftEntry = dep?.iNFTs?.[this.stateAbbr] ?? null;
    this.inftRecord = inftEntry;
    this.tokenId = inftEntry?.tokenId ? BigInt(inftEntry.tokenId) : null;

    const chain = {
      id: opts.chainId,
      name: `chain-${opts.chainId}`,
      nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpc] } },
    } as const;
    this.publicClient = createPublicClient({
      chain,
      transport: http(opts.rpc, { timeout: this.timeoutMs }),
    });
  }

  async refresh(): Promise<OgStatus | null> {
    try {
      const [block, native] = await Promise.all([
        this.publicClient.getBlockNumber(),
        this.publicClient.getBalance({ address: this.walletAddress }),
      ]);

      let inft: OgStatus['inft'] = null;
      if (this.inftAddress && this.tokenId != null && this.inftRecord) {
        try {
          const [onchainUri, onchainOwner] = await Promise.all([
            this.publicClient.readContract({
              address: this.inftAddress,
              abi: INFT_ABI,
              functionName: 'tokenURI',
              args: [this.tokenId],
            }),
            this.publicClient.readContract({
              address: this.inftAddress,
              abi: INFT_ABI,
              functionName: 'ownerOf',
              args: [this.tokenId],
            }),
          ]);
          const expectedOwner = (this.inftRecord.owner_address ?? '') as Address;
          const rootHash = this.inftRecord.root_hash ?? '';
          inft = {
            tokenId: this.tokenId.toString(),
            contract: this.inftAddress,
            onchainOwner: onchainOwner as Address,
            expectedOwner,
            onchainUri: String(onchainUri),
            initialUri: this.inftRecord.encrypted_uri ?? '',
            rootHash,
            mintTx: this.inftRecord.mint_tx ?? '',
            explorerTokenUrl: `${this.explorerBase}/token/${this.inftAddress}?a=${this.tokenId}`,
            explorerStorageUrl: rootHash
              ? `${this.storageExplorerBase}/tx/${rootHash}`
              : undefined,
            ownerMatches:
              expectedOwner.toLowerCase() === String(onchainOwner).toLowerCase(),
          };
        } catch (err) {
          console.warn(
            `[og-reader:${this.stateAbbr}] iNFT read failed: ${(err as Error).message.slice(0, 200)}`,
          );
        }
      }

      return {
        fetchedAt: new Date().toISOString(),
        blockNumber: block.toString(),
        chainId: this.chainId,
        rpc: this.rpc,
        walletAddress: this.walletAddress,
        nativeBalance: formatEther(native),
        nativeBalanceRaw: native.toString(),
        inft,
      };
    } catch (err) {
      console.warn(
        `[og-reader:${this.stateAbbr}] refresh failed: ${(err as Error).message.slice(0, 200)}`,
      );
      return null;
    }
  }
}

function loadOgDeployments(explicit?: string): OgDeploymentsFile | null {
  if (explicit) {
    try {
      return JSON.parse(readFileSync(explicit, 'utf8')) as OgDeploymentsFile;
    } catch {
      return null;
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'contracts', 'deployments', '0g-galileo.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')) as OgDeploymentsFile;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = resolve(parent);
  }
  return null;
}
