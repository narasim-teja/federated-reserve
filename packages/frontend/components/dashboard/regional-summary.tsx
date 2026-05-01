'use client';

import { Globe2 } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNumber } from '@/lib/format';
import type { Health, Region, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';

const REGION_ORDER: Region[] = ['northeast', 'midwest', 'south', 'west', 'territory'];

const TONE: Record<Health, string> = {
  green: 'bg-[var(--color-emerald)]',
  amber: 'bg-[var(--color-amber)]',
  red: 'bg-[var(--color-red)]',
  unknown: 'bg-[var(--color-fg-subtle)]/40',
};

interface RegionalSummaryProps {
  states: StateView[];
}

export function RegionalSummary({ states }: RegionalSummaryProps) {
  const rows = useMemo(() => {
    return REGION_ORDER.map((region) => {
      const subset = states.filter((s) => s.region === region);
      const total = subset.length;
      const counts = subset.reduce<Record<Health, number>>(
        (acc, s) => {
          acc[s.health] = (acc[s.health] ?? 0) + 1;
          return acc;
        },
        { green: 0, amber: 0, red: 0, unknown: 0 },
      );
      return { region, total, counts };
    }).filter((row) => row.total > 0);
  }, [states]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Globe2 className="h-3.5 w-3.5 text-[var(--color-emerald)]" />
          Regional Health
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {states.length} agents
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(({ region, total, counts }) => (
          <div key={region} className="flex items-center gap-3">
            <span className="w-20 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              {region}
            </span>
            <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-soft)]">
              {(['green', 'amber', 'red', 'unknown'] as Health[]).map((h) => {
                const w = total === 0 ? 0 : (counts[h] / total) * 100;
                if (w === 0) return null;
                return (
                  <span key={h} className={cn('h-full', TONE[h])} style={{ width: `${w}%` }} />
                );
              })}
            </div>
            <span className="w-8 text-right font-mono text-xs text-[var(--color-fg-muted)] tabular-nums">
              {formatNumber(total)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
