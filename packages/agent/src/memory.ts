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
    const root =
      opts.rootDir ??
      process.env.MEMORY_ROOT ??
      resolve(process.cwd(), 'memory');
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
 * Pick a memory backend from env. Phase 2 only honors `local`; setting
 * `MEMORY_BACKEND=og` will throw until the 0G implementation lands.
 */
export function makeMemory(opts: LocalDiskMemoryOptions): AgentMemory {
  const backend = (process.env.MEMORY_BACKEND ?? 'local').toLowerCase();
  if (backend === 'local') {
    return new LocalDiskMemory(opts);
  }
  if (backend === 'og') {
    throw new Error(
      'MEMORY_BACKEND=og selected but OgStorageMemory is not implemented yet (Phase 5/6 — needs funded 0G testnet wallet). Use MEMORY_BACKEND=local for now.',
    );
  }
  if (backend === 'memory') {
    return new InMemoryMemory();
  }
  throw new Error(`unknown MEMORY_BACKEND: ${backend} (expected local|og|memory)`);
}
