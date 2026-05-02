/**
 * Agent persistent memory.
 *
 * Two surfaces:
 *
 *   - **State (KV)**: the agent's current treasury composition, latest known
 *     indicators, and other "current" fields. Read on startup, written
 *     after meaningful changes. Single JSON document per agent.
 *
 *   - **Log (append-only)**: a JSONL log of the agent's decisions, received
 *     broadcasts, and reflection notes. The reflection loop reads recent
 *     entries to summarize.
 *
 * Phase 2 ships `LocalDiskMemory` only — files live under
 * `<root>/memory/<agent-key>/`. When the 0G testnet wallet is funded,
 * `OgStorageMemory` will implement the same interface using the 0G Storage
 * SDK (KV root for state, Log for entries) and we flip via env var.
 *
 * The interface intentionally hides the persistence backend so callers
 * can be tested with `InMemoryMemory` without disk I/O.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadAgentKey } from '@federated-reserve/og-inft';
import { OgStorageMemory } from './og-storage-memory.ts';
import type { AgentState } from './state.ts';

export type MemoryLogKind =
  | 'decision'
  | 'reflection'
  | 'broadcast_sent'
  | 'broadcast_received'
  | 'negotiation_round';

export interface MemoryLogEntry {
  kind: MemoryLogKind;
  /** ISO-8601. */
  at: string;
  /** One-line summary suitable for UI feeds and reflection prompts. */
  summary: string;
  /** Optional structured payload for downstream consumers. */
  details?: Record<string, unknown>;
}

export interface AgentMemory {
  /** Returns null on cold-start (no state ever persisted). */
  loadState(): Promise<AgentState | null>;
  saveState(state: AgentState): Promise<void>;
  appendLog(entry: MemoryLogEntry): Promise<void>;
  /** Most recent N entries; default 50, ordered newest-first. */
  recentLog(limit?: number): Promise<MemoryLogEntry[]>;
  /** Identifier for diagnostics and the /healthz response. */
  describe(): string;
}

// --------- LocalDiskMemory ---------------------------------------------------

interface LocalDiskMemoryOptions {
  /** Stable key for this agent — usually `state.abbr` lowercased. */
  agentKey: string;
  /**
   * Root directory; if omitted, resolves in this order:
   *   1. `MEMORY_ROOT` env var (mesh runner sets this to the repo root's
   *      `memory/` so all agents share one location regardless of cwd)
   *   2. `<process.cwd()>/memory` as a final fallback
   */
  rootDir?: string;
}

export class LocalDiskMemory implements AgentMemory {
  private readonly stateFile: string;
  private readonly logFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: LocalDiskMemoryOptions) {
    const root = opts.rootDir ?? process.env.MEMORY_ROOT ?? resolve(process.cwd(), 'memory');
    const dir = resolve(root, opts.agentKey);
    this.stateFile = resolve(dir, 'state.json');
    this.logFile = resolve(dir, 'log.jsonl');
  }

  async loadState(): Promise<AgentState | null> {
    try {
      const raw = await readFile(this.stateFile, 'utf-8');
      return JSON.parse(raw) as AgentState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  saveState(state: AgentState): Promise<void> {
    // Serialize all writes through the queue so concurrent saves don't tear.
    const next = this.writeQueue.then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
    });
    this.writeQueue = next;
    return next;
  }

  async appendLog(entry: MemoryLogEntry): Promise<void> {
    await mkdir(dirname(this.logFile), { recursive: true });
    await appendFile(this.logFile, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  async recentLog(limit = 50): Promise<MemoryLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.logFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit).reverse();
    const entries: MemoryLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as MemoryLogEntry);
      } catch {
        // skip malformed lines silently — the log is best-effort durable
      }
    }
    return entries;
  }

  describe(): string {
    return `LocalDiskMemory(${this.stateFile})`;
  }
}

// --------- InMemoryMemory (test/dev convenience) -----------------------------

export class InMemoryMemory implements AgentMemory {
  private state: AgentState | null = null;
  private log: MemoryLogEntry[] = [];

  async loadState(): Promise<AgentState | null> {
    return this.state ? structuredClone(this.state) : null;
  }
  async saveState(state: AgentState): Promise<void> {
    this.state = structuredClone(state);
  }
  async appendLog(entry: MemoryLogEntry): Promise<void> {
    this.log.push(entry);
  }
  async recentLog(limit = 50): Promise<MemoryLogEntry[]> {
    return this.log.slice(-limit).reverse();
  }
  describe(): string {
    return 'InMemoryMemory';
  }
}

// --------- Factory -----------------------------------------------------------

/**
 * Pick a memory backend from env. Three options:
 *
 *   - `local` (default): file-backed at `<root>/memory/<abbr>/`.
 *   - `memory`: in-process only (tests / CI).
 *   - `og`: 0G Storage as durable substrate, with local-disk hot mirror.
 *           Requires `OG_RPC_URL`, `OG_INDEXER_RPC`, and a signing key
 *           (`OG_STORAGE_SIGNER_PK` or fallback to
 *           `WALLET_<AGENT>_PRIVATE_KEY` / `WALLET_DEPLOYER_PRIVATE_KEY`).
 *           If a per-agent symmetric key exists at
 *           `<memory>/<abbr>/og-key.bin`, blobs are AES-256-GCM encrypted
 *           with the same key the iNFT anchor pipeline uses.
 */
export function makeMemory(opts: LocalDiskMemoryOptions): AgentMemory {
  const backend = (process.env.MEMORY_BACKEND ?? 'local').toLowerCase();
  if (backend === 'local') {
    return new LocalDiskMemory(opts);
  }
  if (backend === 'og') {
    return makeOgStorageMemory(opts);
  }
  if (backend === 'memory') {
    return new InMemoryMemory();
  }
  throw new Error(`unknown MEMORY_BACKEND: ${backend} (expected local|og|memory)`);
}

function makeOgStorageMemory(opts: LocalDiskMemoryOptions): AgentMemory {
  const rpcUrl = process.env.OG_RPC_URL;
  const indexerUrl = process.env.OG_INDEXER_RPC;
  if (!rpcUrl || !indexerUrl) {
    throw new Error('MEMORY_BACKEND=og requires OG_RPC_URL and OG_INDEXER_RPC env vars');
  }

  // Pick a signing key. Per-agent wallets are preferable when present (0G
  // storage txs use the agent's own funds, keeping the deployer faucet
  // balance free for contract admin work). Fall back to deployer otherwise.
  const agentEnvKey = opts.agentKey.toUpperCase();
  const signerPk =
    process.env.OG_STORAGE_SIGNER_PK ??
    process.env[`WALLET_${agentEnvKey}_PRIVATE_KEY`] ??
    process.env.WALLET_DEPLOYER_PRIVATE_KEY;
  if (!signerPk || !signerPk.startsWith('0x') || signerPk === '0xPLACEHOLDER') {
    throw new Error(
      `MEMORY_BACKEND=og requires a signing key (OG_STORAGE_SIGNER_PK or WALLET_${agentEnvKey}_PRIVATE_KEY or WALLET_DEPLOYER_PRIVATE_KEY)`,
    );
  }

  // Optional: encrypt blobs under the same per-agent symmetric key the
  // iNFT bundles use. When absent, plaintext JSON.
  const memoryRoot = opts.rootDir ?? process.env.MEMORY_ROOT ?? `${process.cwd()}/memory`;
  const keyPath = resolve(memoryRoot, opts.agentKey, 'og-key.bin');
  let symmetricKey: Uint8Array | undefined;
  try {
    symmetricKey = loadAgentKey(keyPath);
  } catch {
    symmetricKey = undefined;
  }

  return new OgStorageMemory({
    agentKey: opts.agentKey,
    rootDir: opts.rootDir,
    ogConfig: { rpcUrl, indexerUrl },
    signerPrivateKey: signerPk as `0x${string}`,
    symmetricKey,
  });
}
