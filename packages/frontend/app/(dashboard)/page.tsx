'use client';

import { AiInsightsPanel } from '@/components/dashboard/ai-insights';
import { EventFeed } from '@/components/dashboard/event-feed';
import { GeoMap } from '@/components/dashboard/geo-map';
import { InftGrid } from '@/components/dashboard/inft-grid';
import { InstabilityPanel } from '@/components/dashboard/instability-panel';
import { MapLegend } from '@/components/dashboard/map-legend';
import { NegotiationModal } from '@/components/dashboard/negotiation-modal';
import { OnchainActivity } from '@/components/dashboard/onchain-activity';
import { ReflectionTicker } from '@/components/dashboard/reflection-ticker';
import { ShockRibbon } from '@/components/dashboard/shock-ribbon';
import { StateDetail } from '@/components/dashboard/state-detail';
import { StrategicPosture } from '@/components/dashboard/strategic-posture';
import { Badge } from '@/components/ui/badge';
import { useUtcClock } from '@/hooks/use-clock';
import { useLayers } from '@/hooks/use-layers';
import { useObserverContext } from '@/hooks/use-observer-context';
import { FALLBACK_STATES } from '@/lib/fallback-data';
import { Globe2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const DEFAULT_FOCUS_FIPS = 25; // Massachusetts

export default function LivePage() {
  const { snapshot, events, pulseFor, arcs, expireArc } = useObserverContext();
  const { layers } = useLayers();
  const [selectedFips, setSelectedFips] = useState<number>(DEFAULT_FOCUS_FIPS);
  const [hoveredFips, setHoveredFips] = useState<number | null>(null);
  const [activeNegotiation, setActiveNegotiation] = useState<string | null>(null);

  const states = snapshot?.states.length ? snapshot.states : FALLBACK_STATES;
  const selected = useMemo(
    () => states.find((s) => s.fips === selectedFips) ?? states[0] ?? null,
    [states, selectedFips],
  );

  useEffect(() => {
    if (!layers.deep_only) return;
    if (selected?.tier === 'deep') return;
    const fallback = states.find((s) => s.tier === 'deep');
    if (fallback) setSelectedFips(fallback.fips);
  }, [layers.deep_only, selected, states]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ShockRibbon />
      <div className="flex flex-1 min-h-0">
        <div className="grid flex-1 min-h-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="relative flex min-h-0 flex-col border-r border-[var(--color-border)]">
            <MapHeader />
            <div className="relative flex-1 min-h-[420px]">
              <GeoMap
                states={states}
                selectedFips={selected?.fips ?? null}
                hoveredFips={hoveredFips}
                onSelect={setSelectedFips}
                onHover={setHoveredFips}
                pulseFor={pulseFor}
                deepOnly={layers.deep_only}
                arcs={arcs}
                onArcExpire={expireArc}
              />
              <div className="pointer-events-none absolute bottom-3 left-3">
                <div className="pointer-events-auto">
                  <MapLegend />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-3 border-t border-[var(--color-border)] p-3">
              <EventFeed
                events={events}
                onSelectFips={setSelectedFips}
                onSelectNegotiation={setActiveNegotiation}
              />
              <StateDetail state={selected} />
            </div>
          </section>

          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto bg-[var(--color-bg)]/80 backdrop-blur p-3">
            <ReflectionTicker onSelect={setSelectedFips} selectedFips={selected?.fips ?? null} />
            <AiInsightsPanel snapshot={snapshot} />
            <InstabilityPanel
              states={states}
              selectedFips={selected?.fips ?? null}
              onSelect={setSelectedFips}
            />
            <OnchainActivity swaps={snapshot?.swaps ?? []} onSelectFips={setSelectedFips} />
            <InftGrid entries={snapshot?.infts ?? []} states={states} />
            <StrategicPosture states={states} />
          </aside>
        </div>
      </div>

      <NegotiationModal taskId={activeNegotiation} onClose={() => setActiveNegotiation(null)} />
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
        <Badge variant="muted" className="font-mono">
          2D
        </Badge>
      </div>
    </div>
  );
}
