'use client';

import { Globe2, Maximize2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AiInsightsPanel } from '@/components/dashboard/ai-insights';
import { EventFeed } from '@/components/dashboard/event-feed';
import { GeoMap } from '@/components/dashboard/geo-map';
import { InftGrid } from '@/components/dashboard/inft-grid';
import { InstabilityPanel } from '@/components/dashboard/instability-panel';
import { LeftRail } from '@/components/dashboard/left-rail';
import { MapLegend } from '@/components/dashboard/map-legend';
import { StateDetail } from '@/components/dashboard/state-detail';
import { StrategicPosture } from '@/components/dashboard/strategic-posture';
import { Topbar } from '@/components/dashboard/topbar';
import { Badge } from '@/components/ui/badge';
import { useObserver } from '@/hooks/use-observer';
import { useUtcClock } from '@/hooks/use-clock';
import { LayerProvider, useLayers } from '@/hooks/use-layers';
import { FALLBACK_INFTS, FALLBACK_STATES } from '@/lib/fallback-data';

const DEFAULT_FOCUS_FIPS = 25; // Massachusetts

export default function DashboardPage() {
  return (
    <LayerProvider>
      <DashboardLayout />
    </LayerProvider>
  );
}

function DashboardLayout() {
  const { snapshot, events, connection, pulseFor } = useObserver();
  const { layers } = useLayers();
  const [selectedFips, setSelectedFips] = useState<number>(DEFAULT_FOCUS_FIPS);

  const states = snapshot?.states.length ? snapshot.states : FALLBACK_STATES;
  const infts = snapshot?.infts.length ? snapshot.infts : FALLBACK_INFTS;
  const selected = useMemo(
    () => states.find((s) => s.fips === selectedFips) ?? states[0] ?? null,
    [states, selectedFips],
  );

  // If selection drops out of the active set (deep_only filter), retarget.
  useEffect(() => {
    if (!layers.deep_only) return;
    if (selected?.tier === 'deep') return;
    const fallback = states.find((s) => s.tier === 'deep');
    if (fallback) setSelectedFips(fallback.fips);
  }, [layers.deep_only, selected, states]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Topbar snapshot={snapshot} connection={connection} />

      <div className="flex flex-1 min-h-0">
        <LeftRail />

        <main className="grid flex-1 min-h-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="relative flex min-h-0 flex-col border-r border-[var(--color-border)]">
            <MapHeader />
            <div className="relative flex-1 min-h-[420px]">
              <GeoMap
                states={states}
                selectedFips={selected?.fips ?? null}
                onSelect={setSelectedFips}
                pulseFor={pulseFor}
                deepOnly={layers.deep_only}
              />
              <div className="pointer-events-none absolute bottom-3 left-3">
                <div className="pointer-events-auto">
                  <MapLegend />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-3 border-t border-[var(--color-border)] p-3">
              <EventFeed events={events} />
              <StateDetail state={selected} />
            </div>
          </section>

          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto bg-[var(--color-bg)]/80 backdrop-blur p-3">
            <AiInsightsPanel snapshot={snapshot} />
            <InstabilityPanel
              states={states}
              selectedFips={selected?.fips ?? null}
              onSelect={setSelectedFips}
            />
            <StrategicPosture states={states} />
            <InftGrid entries={infts} />
          </aside>
        </main>
      </div>
    </div>
  );
}

function MapHeader() {
  const clock = useUtcClock();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2">
      <div className="flex items-center gap-2 text-[var(--color-fg-muted)] font-mono text-[10px] uppercase tracking-[0.18em]">
        <Globe2 className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
        Federated Reserve · US Mesh
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        <span className="hidden md:inline tabular-nums text-[var(--color-fg)]">{clock}</span>
        <Badge variant="muted" className="font-mono">2D</Badge>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
