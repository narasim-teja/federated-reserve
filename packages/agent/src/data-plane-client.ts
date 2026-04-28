/**
 * Thin HTTP client to the data plane.
 *
 * Agents poll their own state's snapshot every tick. The data plane handles
 * upstream rate limiting, caching, and disk persistence — agents never call
 * FRED/BLS/etc directly.
 *
 * Failure mode is "soft": if the data plane is unreachable, return null and
 * let the caller decide. tick.ts treats null as "no broadcast this tick"
 * rather than fabricating fake values (PROJECT.md non-goals: never fake data).
 */

import {
  type DataPlaneHealth,
  type StateSnapshot,
  stateSnapshotSchema,
} from '@federated-reserve/shared';

export class DataPlaneClient {
  constructor(private readonly baseUrl: string) {}

  /** Returns the cached snapshot for a state, or `null` if not loaded yet / unreachable. */
  async snapshot(fips: number, signal?: AbortSignal): Promise<StateSnapshot | null> {
    const url = `${this.baseUrl}/snapshot/${fips}`;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      console.warn(`[data-plane-client] unreachable ${url}: ${String(err)}`);
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(
        `[data-plane-client] ${res.status} on ${url}: ${(await res.text()).slice(0, 200)}`,
      );
      return null;
    }
    const json = await res.json();
    const parsed = stateSnapshotSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(`[data-plane-client] bad snapshot from ${url}: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  async healthz(signal?: AbortSignal): Promise<DataPlaneHealth | null> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal });
      if (!res.ok) return null;
      return (await res.json()) as DataPlaneHealth;
    } catch {
      return null;
    }
  }
}
