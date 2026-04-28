/**
 * Snapshot cache with disk persistence.
 *
 * In-memory map keyed by FIPS code, mirrored to a single JSON file on
 * disk. On startup the cache hydrates from disk so the data plane returns
 * last-known values immediately while the first FRED refresh is in flight
 * (and as a fallback when FRED is unreachable — see PROJECT.md non-goals:
 * never fake data, but last-known is fine).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateSnapshot } from '@federated-reserve/shared';

export class SnapshotCache {
  private map = new Map<number, StateSnapshot>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly diskPath: string) {}

  async hydrate(): Promise<void> {
    try {
      const raw = await readFile(this.diskPath, 'utf-8');
      const parsed = JSON.parse(raw) as { snapshots: StateSnapshot[] };
      for (const snap of parsed.snapshots ?? []) {
        this.map.set(snap.state_fips, snap);
      }
      console.log(`[cache] hydrated ${this.map.size} snapshots from ${this.diskPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.log(`[cache] no prior snapshot file at ${this.diskPath} (cold start)`);
      } else {
        console.warn(`[cache] hydrate failed (${String(err)}); starting empty`);
      }
    }
  }

  set(snapshot: StateSnapshot): void {
    this.map.set(snapshot.state_fips, snapshot);
    this.scheduleFlush();
  }

  setMany(snapshots: readonly StateSnapshot[]): void {
    for (const s of snapshots) this.map.set(s.state_fips, s);
    this.scheduleFlush();
  }

  get(fips: number): StateSnapshot | undefined {
    return this.map.get(fips);
  }

  size(): number {
    return this.map.size;
  }

  list(): StateSnapshot[] {
    return [...this.map.values()];
  }

  private scheduleFlush(): void {
    // Serialize writes so concurrent updates don't race.
    this.writeQueue = this.writeQueue
      .then(() => this.flushNow())
      .catch((err) => {
        console.warn(`[cache] flush failed: ${String(err)}`);
      });
  }

  private async flushNow(): Promise<void> {
    const payload = JSON.stringify({ snapshots: this.list() }, null, 2);
    await mkdir(dirname(this.diskPath), { recursive: true });
    await writeFile(this.diskPath, payload, 'utf-8');
  }
}
