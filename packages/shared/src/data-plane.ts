/**
 * Data-plane snapshot types — shared between the ingestion service and
 * agents that read state snapshots over HTTP.
 *
 * The data plane is a single per-mesh service that ingests public economic
 * data (FRED in Phase 2; BLS/BEA/NOAA/GDELT later) and serves normalized
 * snapshots keyed by US state FIPS code. Agents poll their own snapshot
 * cheaply on every tick — they never call FRED directly so the upstream
 * rate limit applies once per mesh, not once per agent.
 */

import { z } from 'zod';
import { type EconomicIndicatorKind, economicIndicatorKindSchema } from './mcp-schemas.ts';

export const indicatorObservationSchema = z.object({
  /** Current value (e.g. 4.2 for 4.2% unemployment). */
  value: z.number(),
  /** Date the upstream source observed this value (ISO-8601, day precision). */
  observation_date: z.string(),
  /** Upstream source identifier (e.g. FRED series ID `MAUR`). */
  source: z.string(),
  /** When the data plane last refreshed this observation (ISO-8601). */
  fetched_at: z.string(),
});
export type IndicatorObservation = z.infer<typeof indicatorObservationSchema>;

export const stateSnapshotSchema = z.object({
  state_fips: z.number().int(),
  state_abbr: z.string(),
  refreshed_at: z.string(),
  /**
   * Keyed by `EconomicIndicatorKind`. May be partial — some series fail or
   * are unavailable for some states. Agents should handle missing keys.
   */
  indicators: z.record(economicIndicatorKindSchema, indicatorObservationSchema.optional()),
});
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

export interface DataPlaneHealth {
  ok: boolean;
  states_loaded: number;
  states_total: number;
  last_refresh_at: string | null;
  upstream_failures_last_hour: number;
}

/**
 * Pick first available indicator for broadcasting from a snapshot.
 * Returns the EconomicIndicatorKind + observation, or `null` if no indicators
 * are populated yet.
 */
export function pickBroadcastIndicator(
  snapshot: StateSnapshot,
  preferred: readonly EconomicIndicatorKind[] = ['unemployment', 'personal_income', 'gdp_growth'],
): { kind: EconomicIndicatorKind; obs: IndicatorObservation } | null {
  for (const kind of preferred) {
    const obs = snapshot.indicators[kind];
    if (obs) return { kind, obs };
  }
  // Fallback: any populated indicator.
  for (const [k, obs] of Object.entries(snapshot.indicators)) {
    if (obs) return { kind: k as EconomicIndicatorKind, obs };
  }
  return null;
}
