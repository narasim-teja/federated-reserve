'use client';

import { ChevronRight, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Health, Region, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';

interface StrategicPostureProps {
  states: StateView[];
}

interface RegionRow {
  region: Region;
  total: number;
  red: number;
  amber: number;
  green: number;
  unknown: number;
  worst: Health;
}

const REGIONS: Region[] = ['northeast', 'midwest', 'south', 'west', 'territory'];

const WORST_LABEL: Record<Health, { label: string; tone: 'red' | 'amber' | 'emerald' | 'muted' }> = {
  red: { label: 'CRIT', tone: 'red' },
  amber: { label: 'ELEV', tone: 'amber' },
  green: { label: 'NORM', tone: 'emerald' },
  unknown: { label: 'IDLE', tone: 'muted' },
};

const REGION_TITLE: Record<Region, string> = {
  northeast: 'Northeast Theater',
  midwest: 'Midwest Theater',
  south: 'South Theater',
  west: 'West Theater',
  territory: 'Territories',
  federal: 'Federal',
};

export function StrategicPosture({ states }: StrategicPostureProps) {
  const rows = useMemo<RegionRow[]>(() => {
    return REGIONS.map((region) => {
      const subset = states.filter((s) => s.region === region);
      const counts = subset.reduce(
        (acc, s) => {
          acc[s.health] = (acc[s.health] ?? 0) + 1;
          return acc;
        },
        { green: 0, amber: 0, red: 0, unknown: 0 } as Record<Health, number>,
      );
      const worst: Health =
        counts.red > 0 ? 'red' : counts.amber > 0 ? 'amber' : counts.green > 0 ? 'green' : 'unknown';
      return { region, total: subset.length, ...counts, worst };
    }).filter((r) => r.total > 0);
  }, [states]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <ShieldAlert className="h-3.5 w-3.5 text-[var(--color-violet)]" />
          AI Strategic Posture
        </CardTitle>
        <Badge variant="violet">{rows.length} theaters</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-2">
        {rows.map((row) => {
          const worst = WORST_LABEL[row.worst];
          const toneCls =
            worst.tone === 'red'
              ? 'border-[color-mix(in_oklch,var(--color-red)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-red)_10%,transparent)]'
              : worst.tone === 'amber'
                ? 'border-[color-mix(in_oklch,var(--color-amber)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-amber)_8%,transparent)]'
                : worst.tone === 'emerald'
                  ? 'border-[color-mix(in_oklch,var(--color-emerald)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-emerald)_6%,transparent)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)]/50';
          return (
            <div
              key={row.region}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md border px-3 py-2',
                toneCls,
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] font-bold tracking-[0.08em] text-[var(--color-fg)]">
                  {REGION_TITLE[row.region]}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Counter label="C" value={row.red} tone="red" />
                <Counter label="W" value={row.amber} tone="amber" />
                <Counter label="N" value={row.green} tone="emerald" />
                <Badge variant={worst.tone}>{worst.label}</Badge>
                <ChevronRight className="h-3 w-3 text-[var(--color-fg-subtle)]" />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'red' | 'amber' | 'emerald';
}) {
  const cls = {
    red: 'text-[var(--color-red)]',
    amber: 'text-[var(--color-amber)]',
    emerald: 'text-[var(--color-emerald)]',
  }[tone];
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
      <span>{label}</span>
      <span className={cn('font-bold tabular-nums', cls)}>{value}</span>
    </span>
  );
}
