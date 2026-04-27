/**
 * Tick loop scaffold.
 *
 * Phase 1: heartbeat + a probabilistic indicator broadcast so the mesh has
 * traffic to look at. Phase 2 replaces this with a real ingestion-→reason-→
 * decide pipeline backed by FRED + OpenRouter + 0G Storage.
 */

import type { AgentConfig } from './config.ts';
import type { AxlClient } from './axl-client.ts';
import { broadcastIndicator } from './broadcast.ts';

const SAMPLE_INDICATORS = [
  { indicator: 'unemployment' as const, base: 4.2, source: 'FRED:UR-state-stub' },
  { indicator: 'gdp_growth' as const, base: 2.1, source: 'FRED:GDPC1-state-stub' },
  { indicator: 'tax_revenue' as const, base: 3.5, source: 'NASBO-stub' },
];

export function startTickLoop(cfg: AgentConfig, axl: AxlClient): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickCount = 0;

  const tick = async () => {
    if (stopped) return;
    tickCount++;
    try {
      // Phase 1 stub: pick one of the sample indicators, jitter the value,
      // broadcast to the mesh. Doesn't matter that it's fake — the test is
      // proving the pipe works.
      const sample = SAMPLE_INDICATORS[tickCount % SAMPLE_INDICATORS.length]!;
      const value = sample.base + (Math.sin(tickCount + cfg.state.fips) * 0.5);
      await broadcastIndicator(cfg, axl, {
        state_fips: cfg.state.fips,
        indicator: sample.indicator,
        value: Number(value.toFixed(3)),
        timestamp: new Date().toISOString(),
        source: sample.source,
      });
    } catch (err) {
      console.error(`[${cfg.state.abbr}] tick ${tickCount} failed:`, err);
    } finally {
      if (!stopped) timer = setTimeout(tick, cfg.tickIntervalMs);
    }
  };

  // First tick fires after a short delay so peers have time to discover us.
  timer = setTimeout(tick, 5_000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
