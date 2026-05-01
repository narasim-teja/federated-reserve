'use client';

import { useMemo } from 'react';
import { STATE_TILE, TILE_COLS, TILE_ROWS } from '@/lib/state-tilegrid';
import type { Health, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { StatusDot } from '@/components/ui/status-dot';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface StateMapProps {
  states: StateView[];
  selected: string | null;
  onSelect: (abbr: string) => void;
  pulseFor: Record<number, number>;
}

const HEALTH_RING: Record<Health, string> = {
  green:
    'border-[color-mix(in_oklch,var(--color-emerald)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-emerald)_14%,transparent)]',
  amber:
    'border-[color-mix(in_oklch,var(--color-amber)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-amber)_14%,transparent)]',
  red: 'border-[color-mix(in_oklch,var(--color-red)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-red)_14%,transparent)]',
  unknown: 'border-[var(--color-border)] bg-[var(--color-bg-soft)]/60',
};

export function StateMap({ states, selected, onSelect, pulseFor }: StateMapProps) {
  const byAbbr = useMemo(() => {
    const map = new Map<string, StateView>();
    for (const s of states) map.set(s.abbr, s);
    return map;
  }, [states]);

  const tiles = useMemo(() => {
    const entries = Object.entries(STATE_TILE) as Array<[string, [number, number]]>;
    return entries.map(([abbr, [row, col]]) => {
      const data = byAbbr.get(abbr);
      const fips = data?.fips;
      const pulseKey = fips != null ? pulseFor[fips] ?? 0 : 0;
      return { abbr, row, col, data, pulseKey };
    });
  }, [byAbbr, pulseFor]);

  return (
    <TooltipProvider delayDuration={120} disableHoverableContent>
      <div className="relative h-full w-full p-3 sm:p-5">
        <div className="absolute inset-0 grid-bg pointer-events-none opacity-60" />
        <div
          className="relative mx-auto grid h-full w-full gap-[6px]"
          style={{
            gridTemplateColumns: `repeat(${TILE_COLS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${TILE_ROWS}, minmax(0, 1fr))`,
            maxWidth: 920,
          }}
        >
          {tiles.map(({ abbr, row, col, data, pulseKey }) => {
            const health: Health = data?.health ?? 'unknown';
            const tier = data?.tier ?? 'observer';
            const isSelected = selected === abbr;
            const isDeep = tier === 'deep';
            return (
              <Tooltip key={abbr}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(abbr)}
                    style={{ gridRow: row + 1, gridColumn: col + 1 }}
                    className={cn(
                      'group relative flex aspect-square items-center justify-center rounded-md border text-[11px] font-semibold tracking-wide transition-all duration-200',
                      HEALTH_RING[health],
                      isSelected
                        ? 'ring-2 ring-[var(--color-cyan)] ring-offset-2 ring-offset-[var(--color-bg)] scale-[1.04] z-10'
                        : 'hover:border-[var(--color-fg-muted)] hover:scale-[1.05] hover:z-10',
                    )}
                  >
                    {isDeep && (
                      <span
                        className="absolute top-1 right-1 h-1 w-1 rounded-full bg-[var(--color-violet)]"
                        aria-label="deep agent"
                      />
                    )}
                    <span className="text-[var(--color-fg)]">{abbr}</span>
                    {/* Pulse layer keyed on pulseKey to retrigger on inbound event */}
                    {pulseKey > 0 && (
                      <span
                        key={pulseKey}
                        className={cn(
                          'pulse-ring absolute inset-0 rounded-md border',
                          health === 'red' && 'border-[var(--color-red)]',
                          health === 'amber' && 'border-[var(--color-amber)]',
                          (health === 'green' || health === 'unknown') &&
                            'border-[var(--color-cyan)]',
                        )}
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono text-[11px]">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusDot health={health} size={8} />
                    <span className="font-sans font-semibold">{data?.name ?? abbr}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[var(--color-fg-muted)]">
                    <span>tier</span>
                    <span className="text-right text-[var(--color-fg)]">{tier}</span>
                    <span>health</span>
                    <span className="text-right text-[var(--color-fg)]">{health}</span>
                    {data?.tick_count != null && (
                      <>
                        <span>ticks</span>
                        <span className="text-right text-[var(--color-fg)]">{data.tick_count}</span>
                      </>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
