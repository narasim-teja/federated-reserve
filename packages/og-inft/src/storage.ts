/**
 * Thin wrapper over @0gfoundation/0g-storage-ts-sdk for upload/download of
 * Uint8Array payloads. Picks indexer + RPC + signer from explicit args so
 * callers can use it from agent runtimes (signed by per-state wallets) or
 * from one-shot scripts (signed by deployer).
 */

import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OgStorageConfig {
  rpcUrl: string;
  indexerUrl: string;
  privateKey: string;
}

export interface UploadResult {
  rootHash: string;
  txHash: string;
  txSeq: number;
  bytes: number;
}

export class OgStorage {
  private indexer: Indexer;
  /**
   * NonceManager-wrapped Wallet so back-to-back uploads from the same wallet
   * don't race on RPC-side nonce sync. The 0G testnet RPC takes 5-15s to
   * reflect a freshly-submitted tx in `getNonce("pending")`; without the
   * manager, ethers re-fetches and reuses the same nonce → tx 2 rejects as
   * REPLACEMENT_UNDERPRICED. NonceManager increments locally on each
   * sendTransaction so subsequent calls deterministically use N+1.
   */
  private signer: NonceManager;
  private rpcUrl: string;

  constructor(cfg: OgStorageConfig) {
    this.rpcUrl = cfg.rpcUrl;
    const provider = new JsonRpcProvider(cfg.rpcUrl);
    this.signer = new NonceManager(new Wallet(cfg.privateKey, provider));
    this.indexer = new Indexer(cfg.indexerUrl);
  }

  /** Anchor `bytes` on 0G Storage. Returns the root hash + on-chain tx hash. */
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    const file = new MemData(bytes);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr !== null || !tree) {
      throw new Error(`merkleTree failed: ${treeErr ?? 'unknown'}`);
    }
    const [res, err] = await this.indexer.upload(file, this.rpcUrl, this.signer);
    if (err !== null) {
      throw new Error(`upload failed: ${err.message ?? err}`);
    }
    const rootHash = ('rootHash' in res ? res.rootHash : res.rootHashes[0]) as string;
    const txHash = ('txHash' in res ? res.txHash : res.txHashes[0]) as string;
    const txSeq = ('txSeq' in res ? res.txSeq : res.txSeqs[0]) as number;
    if (!rootHash || !txHash || txSeq == null) {
      throw new Error('upload result missing rootHash/txHash/txSeq');
    }
    return { rootHash, txHash, txSeq, bytes: bytes.length };
  }

  /** Pull a previously-uploaded blob by its root hash, with retry. */
  async download(rootHash: string, attempts = 8, intervalMs = 5_000): Promise<Uint8Array> {
    const tmp = mkdtempSync(join(tmpdir(), 'og-inft-dl-'));
    const path = join(tmp, 'blob.bin');
    let lastErr: Error | null = null;
    for (let i = 0; i < attempts; i += 1) {
      lastErr = await this.indexer.download(rootHash, path, false);
      if (lastErr === null) {
        const out = readFileSync(path);
        rmSync(tmp, { recursive: true, force: true });
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`download failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
  }
}

/** Build a 0g:// URI from a root hash. Used for the on-chain `encryptedURI`. */
export function rootHashToUri(rootHash: string): string {
  return `0g://${rootHash.startsWith('0x') ? rootHash.slice(2) : rootHash}`;
}

export function rootHashFromUri(uri: string): string {
  if (!uri.startsWith('0g://')) throw new Error(`not a 0g URI: ${uri}`);
  const tail = uri.slice('0g://'.length);
  return tail.startsWith('0x') ? tail : `0x${tail}`;
}
