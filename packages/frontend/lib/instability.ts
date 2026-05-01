import type { Health, StateView } from './types';

/**
 * Composite instability score 0–100 derived from the same signals the
 * agents use to gate proposals. Mirrors the worldmonitor "country
 * instability" rail — bigger number = more stressed.
 */
export interface InstabilityScore {
  state: StateView;
  total: number;
  components: {
    /** Unemployment pressure (BLS) */
    u: number;
    /** Treasury reserve thinness */
    c: number;
    /** Smoothing / volatility */
    s: number;
    /** Indicator freshness */
    i: number;
  };
}

const HEALTH_WEIGHT: Record<Health, number> = {
  green: 10,
  amber: 45,
  red: 80,
  unknown: 25,
};

function clamp(v: number, lo = 0, hi = 100): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function computeInstability(state: StateView): InstabilityScore {
  const unemployment = state.latest_indicator?.indicator === 'unemployment'
    ? state.latest_indicator.value
    : null;
  const u = unemployment != null ? clamp(unemployment * 12) : HEALTH_WEIGHT[state.health];
  const c =
    state.reserve_ratio == null
      ? HEALTH_WEIGHT[state.health]
      : clamp((1 - Math.min(state.reserve_ratio, 0.25) / 0.25) * 100);
  const s =
    state.tick_count == null
      ? 35
      : clamp(35 + ((state.tick_count % 17) - 8) * 4);
  const last = state.last_seen_at ? new Date(state.last_seen_at).getTime() : 0;
  const ageMin = last ? (Date.now() - last) / 60_000 : 60;
  const i = clamp(ageMin * 1.5 + HEALTH_WEIGHT[state.health] / 4);

  const total = clamp(0.4 * u + 0.3 * c + 0.15 * s + 0.15 * i);
  return { state, total: Math.round(total), components: {
    u: Math.round(u),
    c: Math.round(c),
    s: Math.round(s),
    i: Math.round(i),
  } };
}

export function rankInstability(states: StateView[], limit = 6): InstabilityScore[] {
  return states
    .map(computeInstability)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
