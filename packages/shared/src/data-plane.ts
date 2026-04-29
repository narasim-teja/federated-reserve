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
  /**
   * Per-source liveness — agents can detect "FRED stale, BEA fresh" so the
   * reasoner knows what context is current vs cached.
   */
  sources?: Record<string, { last_refresh_at: string | null; last_error: string | null }>;
  /** Phase 4+: how many NOAA shock events the data plane has cached. */
  shocks_loaded?: number;
}

/**
 * NOAA Storm Events — recent named events (tornado, hurricane, flood, etc.)
 * keyed by FIPS code. Drives `coordinate-shock-response` A2A fan-out: the
 * data plane caches the last N events; agents (esp. FED's tick loop) read
 * `/shocks` and emit `shock_event` broadcasts → affected states converge.
 */
export const shockEventSchema = z.object({
  /** Stable id derived from NOAA `EVENT_ID` so dedup across refreshes works. */
  event_id: z.string(),
  /** Affected state's FIPS code (NOAA reports per state). */
  state_fips: z.number().int(),
  state_abbr: z.string(),
  /** NOAA `EVENT_TYPE` like "Hurricane", "Tornado", "Flash Flood". */
  event_type: z.string(),
  /** "natural_disaster" | "market_shock" | "policy_shock" — derived. */
  shock_kind: z.enum(['natural_disaster', 'market_shock', 'policy_shock']),
  /** Severity 1-10 derived from damage estimates and casualty counts. */
  severity: z.number().int().min(1).max(10),
  /** ISO-8601 begin date of the event. */
  begin_date: z.string(),
  /** ISO-8601 end date of the event (may equal begin). */
  end_date: z.string(),
  /** USD property damage estimate, when reported. */
  property_damage_usd: z.number().nullable(),
  /** Direct + indirect deaths reported. */
  deaths: z.number().int().nullable(),
  /** Free-form narrative (truncated). */
  narrative: z.string(),
});
export type ShockEvent = z.infer<typeof shockEventSchema>;

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
