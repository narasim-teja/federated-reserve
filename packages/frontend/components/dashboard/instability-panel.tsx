'use client';

import { ArrowUpRight, Gauge } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusDot } from '@/components/ui/status-dot';
import { computeInstability } from '@/lib/instability';
import type { Health, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';

interface InstabilityPanelProps {
  states: StateView[];
  selectedFips: number | null;
  onSelect: (fips: number) => void;
}

const TONE: Record<Health, string> = {
  green: 'text-[var(--color-emerald)]',
  amber: 'text-[var(--color-amber)]',
  red: 'text-[var(--color-red)]',
  unknown: 'text-[var(--color-fg-subtle)]',
};

const BAR_TONE: Record<Health, string> = {
  green: 'bg-[var(--color-emerald)]',
  amber: 'bg-[var(--color-amber)]',
  red: 'bg-[var(--color-red)]',
  unknown: 'bg-[var(--color-fg-subtle)]',
};

export function InstabilityPanel({
  states,
  selectedFips,
  onSelect,
}: InstabilityPanelProps) {
  const ranked = useMemo(
    () =>
      states
        .map(computeInstability)
        .sort((a, b) => b.total - a.total),
    [states],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Gauge className="h-3.5 w-3.5 text-[var(--color-amber)]" />
          State Instability
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {ranked.length}
        </Badge>
      </CardHeader>
      <CardContent className="flex max-h-80 flex-col gap-1.5 overflow-y-auto p-2">
        {ranked.map(({ state, total, components }) => {
          const isSelected = selectedFips === state.fips;
          return (
            <button
              key={state.fips}
              type="button"
              onClick={() => onSelect(state.fips)}
              className={cn(
                'group flex flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors',
                isSelected
                  ? 'border-[var(--color-cyan)] bg-[color-mix(in_oklch,var(--color-cyan)_10%,transparent)]'
                  : 'border-transparent bg-[var(--color-bg-soft)]/40 hover:border-[var(--color-border-strong)]',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot health={state.health} size={8} />
                  <span className="font-mono text-[12px] font-bold tracking-wide text-[var(--color-fg)]">
                    {state.abbr}
                  </span>
                  <span className="text-[11px] text-[var(--color-fg-muted)] truncate">
                    {state.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('font-mono text-[12px] font-bold tabular-nums', TONE[state.health])}>
                    {total}
                  </span>
                  <ArrowUpRight className="h-3 w-3 text-[var(--color-fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
                  <div
                    className={cn('h-full rounded-full', BAR_TONE[state.health])}
                    style={{ width: `${total}%` }}
                  />
                </div>
                <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
                  <span>U:{components.u}</span>
                  <span>C:{components.c}</span>
                  <span>S:{components.s}</span>
                  <span>I:{components.i}</span>
                </div>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
