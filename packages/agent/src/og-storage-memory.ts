/**
 * OgStorageMemory — 0G-Storage-backed AgentMemory (Phase 5).
 *
 * Where `OgAnchoredMemory` is local-primary + iNFT-mirror (anchors snapshots
 * for the ERC-7857 transfer ceremony), `OgStorageMemory` makes 0G the
 * *durable* substrate for the agent's KV state and append-only log. Local
 * disk is kept as a hot-path mirror so reads and writes never block on the
 * network.
 *
 * Layout per agent:
 *
 *   memory/<abbr>/
 *     state.json              ← LocalDiskMemory mirror (hot path)
 *     log.jsonl               ← LocalDiskMemory mirror (hot path)
 *     og-manifest.json        ← {state: {rootHash, txHash, ...},
 *                                log:   {batches: [{rootHash, ...}]}}
 *
 *   0G Storage:
 *     state blob              ← latest serialized AgentState (encrypted if key)
 *     log batch blobs         ← N entries per batch, JSONL (encrypted if key)
 *
 * Write paths:
 *   - saveState(): writes local mirror synchronously, schedules a 0G upload
 *     in the background. The agent's tick is never blocked on 0G.
 *   - appendLog(): writes local mirror synchronously, buffers the entry for
 *     the next batch flush. Flush triggers: BATCH_SIZE entries OR FLUSH_MS
 *     since last flush OR explicit shutdown.
 *
 * Read paths:
 *   - loadState(): on cold start, tries 0G first if the manifest references
 *     a remote root and local is missing/older; otherwise serves local.
 *   - recentLog(): always served from the local mirror — that's what's hot.
 *
 * Failures:
 *   - Every 0G call is wrapped + counted in `stats`. Failures never propagate
 *     to the agent. A persistent failure window logs a warning but the agent
 *     keeps running on local-mirror.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Hex } from 'viem';
import { decryptBundle, encryptBundle, OgStorage } from '@federated-reserve/og-inft';
import { LocalDiskMemory, type AgentMemory, type MemoryLogEntry } from './memory.ts';
import type { AgentState } from './state.ts';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

interface StateAnchor {
  rootHash: string;
  txHash: string;
  uploadedAt: string;
  tickCount: number;
  /** keccak256(plaintext serialized state) — for integrity verification on download. */
  contentHash: string;
  /** Set when the state blob was AES-256-GCM encrypted with the agent's symmetric key. */
  encrypted: boolean;
  bytes: number;
}

interface LogBatchAnchor {
  rootHash: string;
  txHash: string;
  uploadedAt: string;
  entries: number;
  fromAt: string;
  toAt: string;
  contentHash: string;
  encrypted: boolean;
  bytes: number;
}

interface OgManifest {
  version: 1;
  agent: string;
  /** Set when the most recent saveState made it to 0G. */
  state?: StateAnchor;
  /** Newest-first list of log batch anchors. Bounded by `manifestBatchCap`. */
  logBatches: LogBatchAnchor[];
}

function emptyManifest(agent: string): OgManifest {
  return { version: 1, agent, logBatches: [] };
}

// ---------------------------------------------------------------------------
// Stats / observability
// ---------------------------------------------------------------------------

export interface OgStorageStats {
  /** Total uploads attempted (state + log batches). */
  uploadsAttempted: number;
  uploadsSucceeded: number;
  uploadsFailed: number;
  /** Number of log entries currently buffered awaiting flush. */
  bufferedLogEntries: number;
  /** Latest failure message, for diagnostics. */
  lastError?: string;
  /** ISO timestamp of latest successful upload of any kind. */
  lastSuccessAt?: string;
  /** Whether the cold-start hydrated state from 0G (vs local). */
  coldStartSource?: 'og' | 'local' | 'none';
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OgStorageMemoryOptions {
  /** Stable per-agent key, e.g. "ma" — used as the on-disk dir + manifest agent field. */
  agentKey: string;
  /** Same root the rest of the runtime uses; defaults via env / cwd as in LocalDiskMemory. */
  rootDir?: string;
  /** 0G connection. */
  ogConfig: {
    rpcUrl: string;
    indexerUrl: string;
  };
  /** Signing key for 0G storage submission txs. */
  signerPrivateKey: Hex;
  /**
   * Optional 32-byte AES-256-GCM key. When provided, every blob (state and
   * log batches) is encrypted before upload using the same `encryptBundle`
   * primitive used by the iNFT anchor path. This lets the same key unlock
   * both the iNFT bundle and live storage memory.
   */
  symmetricKey?: Uint8Array;
  /** How many log entries to bundle per batch upload. Default 16. */
  batchSize?: number;
  /** Flush a partial batch after this many ms idle. Default 60s. */
  flushIntervalMs?: number;
  /** How many recent batch anchors to keep in the manifest. Default 64. */
  manifestBatchCap?: number;
  /** When false, never try to hydrate from 0G on cold start. Default true. */
  hydrateOnLoad?: boolean;
  /**
   * Soft pause between consecutive 0G uploads from the same wallet (ms).
   * Belt-and-suspenders alongside the NonceManager in OgStorage — even with
   * deterministic nonce assignment, the testnet indexer occasionally
   * returns "data not finalized" if a second upload's merkle commit lands
   * before the first finalizes. Default 1500ms; in production this is
   * dwarfed by the agent's tick cadence (30s).
   */
  uploadCooldownMs?: number;
}

// ---------------------------------------------------------------------------
// OgStorageMemory implementation
// ---------------------------------------------------------------------------

export class OgStorageMemory implements AgentMemory {
  private readonly mirror: LocalDiskMemory;
  private readonly manifestPath: string;
  private readonly storage: OgStorage;
  private readonly opts: Required<
    Pick<
      OgStorageMemoryOptions,
      'batchSize' | 'flushIntervalMs' | 'manifestBatchCap' | 'hydrateOnLoad' | 'uploadCooldownMs'
    >
  > &
    OgStorageMemoryOptions;
  /** Module-scoped: when two OgStorageMemory instances share a signing
   *  wallet (rare in production — one agent per wallet — but real in tests
   *  and admin scripts), they need to see each other's last-upload time so
   *  back-to-back uploads still respect the testnet nonce cooldown. */
  private static readonly lastUploadByWallet = new Map<string, number>();

  private manifest: OgManifest;
  private manifestLoaded = false;
  private buffer: MemoryLogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private hydrated = false;
  private walletKey = '';

  private stats: OgStorageStats = {
    uploadsAttempted: 0,
    uploadsSucceeded: 0,
    uploadsFailed: 0,
    bufferedLogEntries: 0,
  };

  constructor(opts: OgStorageMemoryOptions) {
    const root = opts.rootDir ?? process.env.MEMORY_ROOT ?? resolve(process.cwd(), 'memory');
    const agentDir = resolve(root, opts.agentKey);
    this.opts = {
      ...opts,
      batchSize: opts.batchSize ?? 16,
      flushIntervalMs: opts.flushIntervalMs ?? 60_000,
      manifestBatchCap: opts.manifestBatchCap ?? 64,
      hydrateOnLoad: opts.hydrateOnLoad ?? true,
      uploadCooldownMs: opts.uploadCooldownMs ?? 3_000,
    };
    this.mirror = new LocalDiskMemory({ agentKey: opts.agentKey, rootDir: root });
    this.manifestPath = resolve(agentDir, 'og-manifest.json');
    this.storage = new OgStorage({
      rpcUrl: opts.ogConfig.rpcUrl,
      indexerUrl: opts.ogConfig.indexerUrl,
      privateKey: opts.signerPrivateKey,
    });
    this.manifest = emptyManifest(opts.agentKey);
    if (opts.symmetricKey && opts.symmetricKey.length !== 32) {
      throw new Error('symmetricKey must be 32 bytes');
    }
    // Cooldown is keyed by the signing wallet's pk hash so two memory
    // instances on the same wallet share a single rate limiter.
    this.walletKey = createHash('sha256').update(opts.signerPrivateKey).digest('hex').slice(0, 16);
  }

  // -- AgentMemory: state ---------------------------------------------------

  async loadState(): Promise<AgentState | null> {
    await this.ensureManifest();
    const local = await this.mirror.loadState();
    if (!this.opts.hydrateOnLoad || this.hydrated) {
      this.stats.coldStartSource = local ? 'local' : 'none';
      return local;
    }
    this.hydrated = true;

    const remoteAnchor = this.manifest.state;
    // Prefer remote ONLY if local is missing OR remote is from a strictly
    // later tick — otherwise local-mirror wins (it's the hot path and may
    // include unflushed updates from the previous run).
    const localTick = local?.tickCount ?? -1;
    const remoteTick = remoteAnchor?.tickCount ?? -1;
    const shouldHydrate = remoteAnchor && remoteTick > localTick;
    if (!shouldHydrate) {
      this.stats.coldStartSource = local ? 'local' : 'none';
      return local;
    }

    try {
      const blob = await this.storage.download(remoteAnchor.rootHash);
      const bytes = this.maybeDecrypt(blob, remoteAnchor.encrypted);
      this.verifyContentHash(bytes, remoteAnchor.contentHash, 'state hydrate');
      const remote = JSON.parse(Buffer.from(bytes).toString('utf8')) as AgentState;
      // Persist to the local mirror so subsequent reads are fast and
      // consistent regardless of 0G availability.
      await this.mirror.saveState(remote);
      this.stats.coldStartSource = 'og';
      console.log(
        `[og-mem ${this.opts.agentKey}] hydrated state from 0G: tick=${remote.tickCount} root=${remoteAnchor.rootHash.slice(0, 12)}…`,
      );
      return remote;
    } catch (err) {
      this.recordFailure(err);
      console.warn(
        `[og-mem ${this.opts.agentKey}] hydrate failed; serving local — ${(err as Error).message}`,
      );
      this.stats.coldStartSource = local ? 'local' : 'none';
      return local;
    }
  }

  async saveState(state: AgentState): Promise<void> {
    await this.mirror.saveState(state);
    // Background fire-and-forget upload; any failure is captured in stats.
    this.scheduleStateUpload(state);
  }

  // -- AgentMemory: log -----------------------------------------------------

  async appendLog(entry: MemoryLogEntry): Promise<void> {
    await this.mirror.appendLog(entry);
    this.buffer.push(entry);
    this.stats.bufferedLogEntries = this.buffer.length;
    if (this.buffer.length >= this.opts.batchSize) {
      this.scheduleFlush(true);
    } else {
      this.scheduleFlush(false);
    }
  }

  recentLog(limit?: number): Promise<MemoryLogEntry[]> {
    // Local mirror is authoritative for the hot read path — it always has
    // every entry the agent ever appended in this process, regardless of
    // 0G upload state.
    return this.mirror.recentLog(limit);
  }

  describe(): string {
    return (
      `OgStorageMemory(agent=${this.opts.agentKey}, ` +
      `uploads=${this.stats.uploadsSucceeded}/${this.stats.uploadsAttempted}, ` +
      `buffered=${this.stats.bufferedLogEntries}, ` +
      `lastErr=${this.stats.lastError ?? 'none'})`
    );
  }

  // -- Lifecycle / introspection -------------------------------------------

  /** Caller-driven shutdown — flush any buffered log entries. Best-effort. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.buffer.length > 0) {
      await this.flushBufferOnce();
    }
    await this.inFlight;
  }

  /** Snapshot for telemetry / `/healthz` rendering. */
  statsSnapshot(): OgStorageStats {
    return { ...this.stats, bufferedLogEntries: this.buffer.length };
  }

  // -- Upload paths --------------------------------------------------------

  private scheduleStateUpload(state: AgentState): void {
    const job = async (): Promise<void> => {
      try {
        const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
        const contentHash = sha256Hex(plaintext);
        const encrypted = !!this.opts.symmetricKey;
        const blob = encrypted ? this.encryptBytes(plaintext) : new Uint8Array(plaintext);
        this.stats.uploadsAttempted += 1;
        const result = await this.storage.upload(blob);
        this.manifest.state = {
          rootHash: result.rootHash,
          txHash: result.txHash,
          uploadedAt: new Date().toISOString(),
          tickCount: state.tickCount,
          contentHash,
          encrypted,
          bytes: blob.length,
        };
        await this.persistManifest();
        this.stats.uploadsSucceeded += 1;
        this.stats.lastSuccessAt = new Date().toISOString();
      } catch (err) {
        this.recordFailure(err);
        console.warn(
          `[og-mem ${this.opts.agentKey}] state upload failed (tick ${state.tickCount}): ${(err as Error).message}`,
        );
      }
    };
    this.chain(job);
  }

  private scheduleFlush(immediate: boolean): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (immediate) {
      this.flushTimer = undefined;
      this.chain(() => this.flushBufferOnce());
    } else {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.chain(() => this.flushBufferOnce());
      }, this.opts.flushIntervalMs);
      // Allow the process to exit even if a timer is pending.
      this.flushTimer.unref?.();
    }
  }

  private async flushBufferOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    const drained = this.buffer.splice(0, this.buffer.length);
    this.stats.bufferedLogEntries = this.buffer.length;
    try {
      const jsonl = `${drained.map((e) => JSON.stringify(e)).join('\n')}\n`;
      const plaintext = Buffer.from(jsonl, 'utf8');
      const contentHash = sha256Hex(plaintext);
      const encrypted = !!this.opts.symmetricKey;
      const blob = encrypted ? this.encryptBytes(plaintext) : new Uint8Array(plaintext);
      this.stats.uploadsAttempted += 1;
      const result = await this.storage.upload(blob);
      this.manifest.logBatches.unshift({
        rootHash: result.rootHash,
        txHash: result.txHash,
        uploadedAt: new Date().toISOString(),
        entries: drained.length,
        fromAt: drained[0]?.at ?? '',
        toAt: drained[drained.length - 1]?.at ?? '',
        contentHash,
        encrypted,
        bytes: blob.length,
      });
      // Bound manifest growth.
      if (this.manifest.logBatches.length > this.opts.manifestBatchCap) {
        this.manifest.logBatches.length = this.opts.manifestBatchCap;
      }
      await this.persistManifest();
      this.stats.uploadsSucceeded += 1;
      this.stats.lastSuccessAt = new Date().toISOString();
    } catch (err) {
      // On failure, requeue the entries so a future flush can retry.
      // Local-mirror already has them, so durability is preserved either way.
      this.buffer.unshift(...drained);
      this.stats.bufferedLogEntries = this.buffer.length;
      this.recordFailure(err);
      console.warn(
        `[og-mem ${this.opts.agentKey}] log batch flush failed (${drained.length} entries requeued): ${(err as Error).message}`,
      );
    }
  }

  // -- Manifest helpers ----------------------------------------------------

  private async ensureManifest(): Promise<void> {
    if (this.manifestLoaded) return;
    if (existsSync(this.manifestPath)) {
      try {
        const raw = await readFile(this.manifestPath, 'utf8');
        const parsed = JSON.parse(raw) as OgManifest;
        if (parsed.version === 1 && parsed.agent === this.opts.agentKey) {
          this.manifest = parsed;
        }
      } catch (err) {
        console.warn(
          `[og-mem ${this.opts.agentKey}] manifest unreadable (${(err as Error).message}); starting fresh`,
        );
      }
    }
    this.manifestLoaded = true;
  }

  private async persistManifest(): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true });
    await writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
  }

  // -- Crypto helpers ------------------------------------------------------

  private encryptBytes(plaintext: Uint8Array): Uint8Array {
    const key = this.opts.symmetricKey;
    if (!key) throw new Error('encryptBytes called without symmetricKey');
    // Reuse the iNFT AES-256-GCM primitive — same key unlocks both the
    // anchor bundle and storage memory blobs. encryptBundle returns
    // { blob: iv || ciphertext, ... }; the blob is what goes to 0G.
    return encryptBundle(plaintext, key).blob;
  }

  private maybeDecrypt(blob: Uint8Array, encrypted: boolean): Uint8Array {
    if (!encrypted) return blob;
    const key = this.opts.symmetricKey;
    if (!key) {
      throw new Error(
        `manifest claims encrypted blob but no symmetricKey configured for ${this.opts.agentKey}`,
      );
    }
    return decryptBundle(blob, key);
  }

  private verifyContentHash(bytes: Uint8Array, expected: string, ctx: string): void {
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(
        `${ctx}: content hash mismatch — expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
  }

  private recordFailure(err: unknown): void {
    this.stats.uploadsFailed += 1;
    this.stats.lastError = err instanceof Error ? err.message : String(err);
  }

  // -- Concurrency --------------------------------------------------------

  /**
   * Serialize all 0G operations through one queue so manifest writes don't
   * race and so we don't fan out N concurrent storage uploads from a hot
   * tick. Each chained job is wrapped to never throw — failures land in
   * `recordFailure` instead. We also enforce a per-wallet cooldown between
   * consecutive uploads so the next ethers `getNonce("pending")` call sees
   * the prior tx — without this, back-to-back uploads from the same wallet
   * race on nonce and the second one rejects as REPLACEMENT_UNDERPRICED.
   */
  private chain(job: () => Promise<void>): void {
    this.inFlight = this.inFlight.then(async () => {
      const lastAt = OgStorageMemory.lastUploadByWallet.get(this.walletKey) ?? 0;
      const elapsed = Date.now() - lastAt;
      if (elapsed < this.opts.uploadCooldownMs) {
        await new Promise((r) => setTimeout(r, this.opts.uploadCooldownMs - elapsed));
      }
      try {
        await job();
      } catch (err) {
        this.recordFailure(err);
      } finally {
        OgStorageMemory.lastUploadByWallet.set(this.walletKey, Date.now());
      }
    });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
