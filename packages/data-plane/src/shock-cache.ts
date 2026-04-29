/**
 * Shock event cache (NOAA-driven).
 *
 * Mirrors `SnapshotCache` but stores `ShockEvent[]` keyed by event_id with
 * a per-state index for fast `/shocks/state/:fips` lookups. Disk-persisted
 * to `.data/shocks-cache.json` so the cache survives restarts.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ShockEvent } from '@federated-reserve/shared';

export class ShockCache {
  private byId = new Map<string, ShockEvent>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly diskPath: string) {}

  async hydrate(): Promise<void> {
    try {
      const raw = await readFile(this.diskPath, 'utf-8');
      const parsed = JSON.parse(raw) as { events: ShockEvent[] };
      for (const ev of parsed.events ?? []) {
        this.byId.set(ev.event_id, ev);
      }
      console.log(`[shock-cache] hydrated ${this.byId.size} events from ${this.diskPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.log(`[shock-cache] no prior cache at ${this.diskPath} (cold start)`);
      } else {
        console.warn(`[shock-cache] hydrate failed (${String(err)}); starting empty`);
      }
    }
  }

  /** Replace the entire cache with the given events (full refresh). */
  setAll(events: readonly ShockEvent[]): void {
    this.byId = new Map(events.map((e) => [e.event_id, e] as const));
    this.scheduleFlush();
  }

  list(): ShockEvent[] {
    return [...this.byId.values()];
  }

  size(): number {
    return this.byId.size;
  }

  /** Most-severe-first events for a single state. */
  forState(fips: number, limit = 10): ShockEvent[] {
    const out: ShockEvent[] = [];
    for (const ev of this.byId.values()) {
      if (ev.state_fips === fips) out.push(ev);
    }
    out.sort((a, b) => b.severity - a.severity || b.begin_date.localeCompare(a.begin_date));
    return out.slice(0, limit);
  }

  /** Across-states: top N most severe events overall. */
  topSevere(limit = 20): ShockEvent[] {
    const out = [...this.byId.values()];
    out.sort((a, b) => b.severity - a.severity || b.begin_date.localeCompare(a.begin_date));
    return out.slice(0, limit);
  }

  private scheduleFlush(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.flushNow())
      .catch((err) => {
        console.warn(`[shock-cache] flush failed: ${String(err)}`);
      });
  }

  private async flushNow(): Promise<void> {
    const payload = JSON.stringify({ events: this.list() }, null, 2);
    await mkdir(dirname(this.diskPath), { recursive: true });
    await writeFile(this.diskPath, payload, 'utf-8');
  }
}
