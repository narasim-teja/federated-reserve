'use client';

import { useMemo } from 'react';
import { useUsAtlas, useStateLookup } from '@/hooks/use-us-atlas';
import type { Health, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';

interface GeoMapProps {
  states: StateView[];
  selectedFips: number | null;
  onSelect: (fips: number) => void;
  /** Map of fips → monotonic counter; flashes a ring when the value changes. */
  pulseFor: Record<number, number>;
  /** When true, dim observer-tier states. */
  deepOnly: boolean;
}

const FILL: Record<Health, string> = {
  green: 'fill-[color-mix(in_oklch,var(--color-emerald)_22%,transparent)] hover:fill-[color-mix(in_oklch,var(--color-emerald)_36%,transparent)]',
  amber: 'fill-[color-mix(in_oklch,var(--color-amber)_24%,transparent)] hover:fill-[color-mix(in_oklch,var(--color-amber)_38%,transparent)]',
  red: 'fill-[color-mix(in_oklch,var(--color-red)_28%,transparent)] hover:fill-[color-mix(in_oklch,var(--color-red)_42%,transparent)]',
  unknown: 'fill-[var(--color-bg-soft)] hover:fill-[var(--color-surface-elevated)]',
};

const STROKE: Record<Health, string> = {
  green: 'stroke-[color-mix(in_oklch,var(--color-emerald)_55%,transparent)]',
  amber: 'stroke-[color-mix(in_oklch,var(--color-amber)_55%,transparent)]',
  red: 'stroke-[color-mix(in_oklch,var(--color-red)_55%,transparent)]',
  unknown: 'stroke-[var(--color-border-strong)]',
};

const PULSE_COLOR: Record<Health, string> = {
  green: 'var(--color-emerald)',
  amber: 'var(--color-amber)',
  red: 'var(--color-red)',
  unknown: 'var(--color-cyan)',
};

export function GeoMap({ states, selectedFips, onSelect, pulseFor, deepOnly }: GeoMapProps) {
  const { data: atlas, error } = useUsAtlas();
  const lookup = useStateLookup(atlas);

  const stateByFips = useMemo(() => {
    const m = new Map<number, StateView>();
    for (const s of states) m.set(s.fips, s);
    return m;
  }, [states]);

  const pulses = useMemo(() => {
    if (!atlas) return [] as Array<{ fips: number; cx: number; cy: number; key: number; health: Health }>;
    return Object.entries(pulseFor)
      .map(([fipsStr, key]) => {
        const fips = Number(fipsStr);
        const feat = lookup.get(fips);
        if (!feat || !key) return null;
        const stateView = stateByFips.get(fips);
        return {
          fips,
          cx: feat.centroid[0],
          cy: feat.centroid[1],
          key,
          health: stateView?.health ?? 'unknown',
        };
      })
      .filter(Boolean) as Array<{ fips: number; cx: number; cy: number; key: number; health: Health }>;
  }, [atlas, lookup, pulseFor, stateByFips]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-red)]">
        Atlas load failed: {error}
      </div>
    );
  }

  if (!atlas) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-fg-subtle)] font-mono uppercase tracking-[0.2em]">
        Loading topology…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0 grid-bg pointer-events-none opacity-50" />
      <svg
        viewBox={atlas.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="relative h-full w-full"
        role="img"
        aria-label="US state mesh map"
      >
        <defs>
          <filter id="state-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>

        {/* Country border halo */}
        <path d={atlas.borderD} className="fill-none stroke-[var(--color-cyan)]/25" strokeWidth={3} filter="url(#state-glow)" />

        {/* States */}
        <g>
          {atlas.states.map((feat) => {
            const data = stateByFips.get(feat.fips);
            const health: Health = data?.health ?? 'unknown';
            const isSelected = selectedFips === feat.fips;
            const dimmed = deepOnly && data?.tier !== 'deep';
            return (
              <path
                key={feat.id}
                d={feat.d}
                onClick={() => onSelect(feat.fips)}
                className={cn(
                  'cursor-pointer transition-[fill,stroke,opacity] duration-200',
                  FILL[health],
                  STROKE[health],
                  isSelected && 'fill-[color-mix(in_oklch,var(--color-cyan)_30%,transparent)] stroke-[var(--color-cyan)]',
                  dimmed && 'opacity-25',
                )}
                strokeWidth={isSelected ? 1.4 : 0.6}
              >
                <title>
                  {feat.name} · {health}
                </title>
              </path>
            );
          })}
        </g>

        {/* Country border (top, crisp line) */}
        <path
          d={atlas.borderD}
          className="fill-none stroke-[var(--color-border-strong)]"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />

        {/* Deep-agent markers */}
        <g>
          {atlas.states.map((feat) => {
            const data = stateByFips.get(feat.fips);
            if (data?.tier !== 'deep') return null;
            return (
              <circle
                key={`deep-${feat.id}`}
                cx={feat.centroid[0]}
                cy={feat.centroid[1]}
                r={2.4}
                className="fill-[var(--color-violet)]"
              />
            );
          })}
        </g>

        {/* Event pulses */}
        <g>
          {pulses.map(({ fips, cx, cy, key, health }) => (
            <g key={`${fips}-${key}`}>
              <circle
                cx={cx}
                cy={cy}
                r={4}
                fill={PULSE_COLOR[health]}
                opacity={0.7}
              >
                <animate attributeName="r" from={4} to={22} dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" from={0.7} to={0} dur="1.6s" repeatCount="indefinite" />
              </circle>
              <circle cx={cx} cy={cy} r={2.5} fill={PULSE_COLOR[health]} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
