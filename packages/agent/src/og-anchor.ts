/**
 * 0G iNFT memory anchor.
 *
 * Wraps a base `AgentMemory` (typically `LocalDiskMemory`) and mirrors
 * "material" state changes to 0G:
 *
 *   1. Encrypt the agent's full bundle (persona + memory_state + recent log)
 *      with a fresh AES-256-GCM key.
 *   2. Upload `iv || ciphertext` to 0G Storage → root hash.
 *   3. Seal the AES key under the *current iNFT owner's* secp256k1 pubkey
 *      so only they can decrypt.
 *   4. INFT7857.updateMetadata(tokenId, "0g://<root>", keccak256(plaintext)).
 *
 * Anchors are throttled: at least `minIntervalMs` between successful runs,
 * plus a `tickHeartbeat` cap so even quiet states still produce visible
 * on-chain activity. Local writes never block on 0G — anchoring runs as a
 * fire-and-forget side channel, with backpressure via `inFlight`.
 */

import { keccak256 } from 'viem';
import {
  type AgentBundle,
  bundleToBytes,
  encryptBundle,
  INFTContract,
  OgStorage,
  rootHashToUri,
} from '@federated-reserve/og-inft';
import type { Address, Hex } from 'viem';
import type { AgentMemory, MemoryLogEntry } from './memory.ts';
import type { AgentState } from './state.ts';

export interface OgAnchorPolicy {
  /** Minimum ms between successful anchors. */
  minIntervalMs: number;
  /** Force an anchor every N ticks regardless of deltas. */
  tickHeartbeat: number;
  /** Reserve-ratio change in basis points required to trigger. */
  reserveRatioDeltaBps: number;
  /** Total-value change in basis points required to trigger. */
  totalValueDeltaBps: number;
  /** Treasury-composition shift threshold (any single asset, basis points). */
  compositionDeltaBps: number;
  /** If a decision/reflection log entry arrives, force the next saveState anchor. */
  decisionTriggers: boolean;
}

export const DEFAULT_OG_ANCHOR_POLICY: OgAnchorPolicy = {
  minIntervalMs: 90_000,
  tickHeartbeat: 6,
  reserveRatioDeltaBps: 100,
  totalValueDeltaBps: 50,
  compositionDeltaBps: 500,
  decisionTriggers: true,
};

export interface OgAnchorOptions {
  base: AgentMemory;
  stateAbbr: string;
  stateName: string;
  stateFips: number;
  persona: unknown;
  /** ERC-7857 token id minted for this agent. */
  tokenId: bigint;
  /** Address that currently owns the iNFT — surfaced in describe() / stats. */
  ownerAddress: Address;
  /** Long-lived AES-256-GCM key (32 bytes) used to encrypt every memory
   *  snapshot for this iNFT. Same key is also sealed on-chain under the
   *  current owner's pubkey, so any successful unseal recovers it and can
   *  decrypt all past + future anchors. */
  symmetricKey: Uint8Array;
  /** Private key signing INFT7857.updateMetadata. May be deployer (contract
   *  admin) when per-state wallets are unfunded. */
  signerPrivateKey: Hex;
  ogConfig: {
    rpcUrl: string;
    indexerUrl: string;
    chainId: number;
    inftAddress: Address;
    explorerBase?: string;
  };
  policy?: Partial<OgAnchorPolicy>;
  /** Number of recent log entries to embed in each anchored bundle. */
  recentLogLimit?: number;
}

interface AnchorRecord {
  rootHash: string;
  metadataHash: Hex;
  storageTx: string;
  /** 0G Storage sequence number — resolves /submission/<txSeq> on storagescan. */
  txSeq?: string;
  updateMetadataTx: string;
  bundleBytes: number;
  encryptedBytes: number;
  at: string;
  reason: string;
  tickCount: number;
}

export interface OgAnchorStats {
  attempts: number;
  successes: number;
  failures: number;
  lastReason?: string;
  lastError?: string;
  lastAnchor?: AnchorRecord;
  inFlight: number;
}

/** Memory wrapper that mirrors saved state to 0G as ERC-7857 anchor updates. */
export class OgAnchoredMemory implements AgentMemory {
  private readonly base: AgentMemory;
  private readonly opts: OgAnchorOptions;
  private readonly policy: OgAnchorPolicy;
  private readonly storage: OgStorage;
  private readonly inft: INFTContract;
  private readonly symmetricKey: Uint8Array;
  private readonly recentLogLimit: number;

  private lastAnchorAtMs = 0;
  private lastAnchoredTick = -Infinity;
  private lastAnchoredState?: { reserveRatio: number; totalValueUsd: number; compositionKey: string };
  private decisionPending = false;
  private inFlight = 0;
  private stats: OgAnchorStats = { attempts: 0, successes: 0, failures: 0, inFlight: 0 };
  /**
   * Set to `true` permanently after a transfer-aware revert (caller is no
   * longer the iNFT owner). We don't try to anchor again for the lifetime of
   * the process — re-attempting won't suddenly make the call succeed.
   */
  private permanentlyDisabled = false;
  private permanentlyDisabledReason?: string;
  /**
   * Wall-clock at which this agent is allowed to attempt its first anchor.
   * Without jitter, all N agents fire on tick 1 simultaneously and overwhelm
   * 0G's RPC rate limit (50 req/window). We pseudo-random-spread by FIPS so
   * the same agent always has the same offset (deterministic for tests).
   */
  private readonly startupReadyAtMs: number;

  constructor(opts: OgAnchorOptions) {
    this.base = opts.base;
    this.opts = opts;
    this.policy = { ...DEFAULT_OG_ANCHOR_POLICY, ...opts.policy };
    this.recentLogLimit = opts.recentLogLimit ?? 24;
    // Spread first anchors across 0–60s based on FIPS so concurrent boots
    // don't collide on the 0G indexer.
    const jitterMs = (opts.stateFips * 7919) % 60_000;
    this.startupReadyAtMs = Date.now() + jitterMs;
    if (opts.symmetricKey.length !== 32) throw new Error('symmetricKey must be 32 bytes');
    this.symmetricKey = opts.symmetricKey;
    this.storage = new OgStorage({
      rpcUrl: opts.ogConfig.rpcUrl,
      indexerUrl: opts.ogConfig.indexerUrl,
      privateKey: opts.signerPrivateKey,
    });
    this.inft = new INFTContract({
      rpcUrl: opts.ogConfig.rpcUrl,
      chainId: opts.ogConfig.chainId,
      privateKey: opts.signerPrivateKey,
      inftAddress: opts.ogConfig.inftAddress,
      explorerBase: opts.ogConfig.explorerBase,
    });
  }

  // -- AgentMemory pass-through --------------------------------------------

  loadState(): Promise<AgentState | null> {
    return this.base.loadState();
  }

  async saveState(state: AgentState): Promise<void> {
    await this.base.saveState(state);
    this.maybeAnchor(state).catch((err) => this.recordFailure(err, 'saveState'));
  }

  async appendLog(entry: MemoryLogEntry): Promise<void> {
    await this.base.appendLog(entry);
    if (this.policy.decisionTriggers && (entry.kind === 'decision' || entry.kind === 'reflection')) {
      this.decisionPending = true;
    }
  }

  recentLog(limit?: number): Promise<MemoryLogEntry[]> {
    return this.base.recentLog(limit);
  }

  describe(): string {
    return `OgAnchoredMemory(base=${this.base.describe()}, token=${this.opts.tokenId}, anchors=${this.stats.successes}/${this.stats.attempts})`;
  }

  // -- public introspection -------------------------------------------------

  getStats(): OgAnchorStats {
    return { ...this.stats, inFlight: this.inFlight };
  }

  // -- anchor pipeline ------------------------------------------------------

  private compositionKey(state: AgentState): string {
    return state.composition.map((a) => `${a.asset}:${a.balance}`).join('|');
  }

  private anchorReason(state: AgentState): string | null {
    if (this.permanentlyDisabled) return null;
    const now = Date.now();
    // Startup jitter — let the deterministic per-FIPS offset spread the
    // first-attempt thundering herd across the 0G indexer.
    if (now < this.startupReadyAtMs) return null;
    if (this.stats.successes === 0) return 'cold-start';
    if (now - this.lastAnchorAtMs < this.policy.minIntervalMs) return null;
    if (this.decisionPending) return 'decision';
    const last = this.lastAnchoredState;
    if (!last) return 'no-prior-state';
    const tickGap = state.tickCount - this.lastAnchoredTick;
    if (tickGap >= this.policy.tickHeartbeat) return `heartbeat-${tickGap}-ticks`;
    const totalValueDelta = last.totalValueUsd === 0
      ? Infinity
      : Math.abs(state.totalValueUsd - last.totalValueUsd) / last.totalValueUsd;
    if (totalValueDelta * 10_000 >= this.policy.totalValueDeltaBps) {
      return `value-delta-${(totalValueDelta * 10_000).toFixed(0)}bps`;
    }
    const ratioDelta = Math.abs(state.reserveRatio - last.reserveRatio);
    if (ratioDelta * 10_000 >= this.policy.reserveRatioDeltaBps) {
      return `ratio-delta-${(ratioDelta * 10_000).toFixed(0)}bps`;
    }
    if (this.compositionKey(state) !== last.compositionKey) {
      return 'composition-change';
    }
    return null;
  }

  private async maybeAnchor(state: AgentState): Promise<void> {
    if (this.inFlight >= 2) return; // backpressure — don't pile up uploads
    const reason = this.anchorReason(state);
    if (!reason) return;
    this.inFlight += 1;
    this.stats.attempts += 1;
    this.stats.lastReason = reason;
    try {
      await this.runAnchor(state, reason);
      this.decisionPending = false;
    } finally {
      this.inFlight -= 1;
    }
  }

  private async runAnchor(state: AgentState, reason: string): Promise<void> {
    const recentLog = await this.base.recentLog(this.recentLogLimit);
    const bundle: AgentBundle = {
      version: 1,
      state_abbr: this.opts.stateAbbr,
      state_name: this.opts.stateName,
      state_fips: this.opts.stateFips,
      persona: this.opts.persona,
      memory_state: state,
      recent_log: recentLog,
      generated_at: new Date().toISOString(),
      generator: `agent-runtime/${this.opts.stateAbbr}`,
    };
    const plaintext = bundleToBytes(bundle);
    const cipher = encryptBundle(plaintext, this.symmetricKey);

    const t0 = Date.now();
    const upload = await this.storage.upload(cipher.blob);
    const encryptedURI = rootHashToUri(upload.rootHash);
    const metadataHash = keccak256(plaintext);

    const { tx } = await this.inft.updateMetadata({
      tokenId: this.opts.tokenId,
      newURI: encryptedURI,
      newHash: metadataHash,
    });
    const elapsed = Date.now() - t0;

    const record: AnchorRecord = {
      rootHash: upload.rootHash,
      metadataHash,
      storageTx: upload.txHash,
      txSeq: upload.txSeq != null ? String(upload.txSeq) : undefined,
      updateMetadataTx: tx,
      bundleBytes: plaintext.length,
      encryptedBytes: cipher.blob.length,
      at: new Date().toISOString(),
      reason,
      tickCount: state.tickCount,
    };
    this.stats.successes += 1;
    this.stats.lastAnchor = record;
    this.lastAnchorAtMs = Date.now();
    this.lastAnchoredTick = state.tickCount;
    this.lastAnchoredState = {
      reserveRatio: state.reserveRatio,
      totalValueUsd: state.totalValueUsd,
      compositionKey: this.compositionKey(state),
    };
    // Persist the anchor onto the same AgentState the caller is holding so
    // the next tick's saveState writes it to disk → observer hydrates it →
    // dashboard shows a live `/submission/<txSeq>` link to the freshest blob.
    state.lastAnchor = {
      rootHash: record.rootHash,
      txSeq: record.txSeq,
      storageTx: record.storageTx,
      updateMetadataTx: record.updateMetadataTx,
      reason: record.reason,
      tickCount: record.tickCount,
      at: record.at,
    };
    // Best-effort: log the anchor as a memory event so the frontend feed sees it.
    await this.base
      .appendLog({
        kind: 'reflection',
        at: record.at,
        summary: `0G anchor (${reason}) → ${upload.rootHash.slice(0, 14)}…`,
        details: { ...record },
      })
      .catch(() => {});
    console.log(
      `[og-anchor:${this.opts.stateAbbr}] ${reason} -> tokenId=${this.opts.tokenId} root=${upload.rootHash.slice(0, 12)}… tx=${tx.slice(0, 12)}… (${elapsed}ms)`,
    );
  }

  private recordFailure(err: unknown, ctx: string): void {
    this.stats.failures += 1;
    const msg = (err as Error)?.message ?? String(err);
    this.stats.lastError = `${ctx}: ${msg}`;
    // Detect "current owner ≠ this signer" by error shape — the iNFT was
    // transferred away (e.g. via scripts/transfer-inft.ts), so further
    // updateMetadata calls will keep reverting forever. Disable the anchor
    // pipeline permanently for this process; the local memory keeps working.
    if (
      msg.includes('execution reverted') &&
      msg.includes('updateMetadata')
    ) {
      this.permanentlyDisabled = true;
      this.permanentlyDisabledReason = 'updateMetadata reverted (likely iNFT ownership transferred away)';
      console.warn(
        `[og-anchor:${this.opts.stateAbbr}] disabling anchor pipeline — ${this.permanentlyDisabledReason}`,
      );
    }
    console.error(`[og-anchor:${this.opts.stateAbbr}] ${this.stats.lastError.slice(0, 240)}`);
  }
}
