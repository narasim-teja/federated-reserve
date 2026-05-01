'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { lookupStateByFips } from '@/lib/states';
import { cn } from '@/lib/utils';

interface PeerSignalsProps {
  indicators: ReceivedIndicator[];
  /** Ignore the pivot's own broadcasts. */
  pivotFips?: number;
  className?: string;
  /** Cap rows shown; default 8. */
  limit?: number;
}

export interface ReceivedIndicator {
  state_fips: number;
  indicator: string;
  value: number;
  timestamp?: string;
  source?: string;
  receivedAt?: string;
}

interface IndicatorRow {
  fips: number;
  abbr: string;
  indicator: string;
  value: number;
  pct: number;
  tone: string;
  hint: string;
}

interface IndicatorScale {
  /** Lower bound of the scale used for the bar. */
  min: number;
  /** Upper bound of the scale (where the bar fills 100%). */
  max: number;
  /** Threshold above which the value is "stress". */
  redAt: number;
  /** Threshold above which the value is "watch". */
  amberAt: number;
  /** Lower-is-better? Default true (unemployment, poverty). */
  inverted?: boolean;
  /** Suffix shown after the number. */
  suffix?: string;
}

const SCALES: Record<string, IndicatorScale> = {
  unemployment: { min: 2, max: 10, amberAt: 5.5, redAt: 7, suffix: '%' },
  cpi:           { min: 0, max: 8,  amberAt: 4,   redAt: 6,   suffix: '%' },
  poverty_rate:  { min: 5, max: 20, amberAt: 12,  redAt: 16,  suffix: '%' },
  gdp_growth:    { min: -3, max: 5, amberAt: 0,   redAt: -1,  inverted: false, suffix: '%' },
};

const FALLBACK_SCALE: IndicatorScale = {
  min: 0,
  max: 10,
  amberAt: 6,
  redAt: 8,
};

function classify(value: number, scale: IndicatorScale): { tone: string; pct: number } {
  const range = Math.max(0.001, scale.max - scale.min);
  const norm = Math.max(0, Math.min(1, (value - scale.min) / range));
  let tone = 'var(--color-emerald)';
  if (scale.inverted) {
    if (value <= scale.redAt) tone = 'var(--color-red)';
    else if (value <= scale.amberAt) tone = 'var(--color-amber)';
  } else {
    if (value >= scale.redAt) tone = 'var(--color-red)';
    else if (value >= scale.amberAt) tone = 'var(--color-amber)';
  }
  return { tone, pct: norm };
}

export function PeerSignals({ indicators, pivotFips, className, limit = 8 }: PeerSignalsProps) {
  const rows = useMemo<IndicatorRow[]>(() => {
    if (!indicators?.length) return [];
    // Take the latest entry per (state, indicator). Sort by recency.
    const latestByKey = new Map<string, ReceivedIndicator>();
    for (const x of indicators) {
      if (pivotFips != null && x.state_fips === pivotFips) continue;
      const key = `${x.state_fips}:${x.indicator}`;
      const prev = latestByKey.get(key);
      if (!prev) {
        latestByKey.set(key, x);
        continue;
      }
      const a = x.receivedAt ?? x.timestamp ?? '';
      const b = prev.receivedAt ?? prev.timestamp ?? '';
      if (a > b) latestByKey.set(key, x);
    }
    const ordered = [...latestByKey.values()].sort((a, b) => {
      const ax = a.receivedAt ?? a.timestamp ?? '';
      const bx = b.receivedAt ?? b.timestamp ?? '';
      return bx.localeCompare(ax);
    });
    return ordered.slice(0, limit).map((x) => {
      const meta = lookupStateByFips(x.state_fips);
      const scale = SCALES[x.indicator] ?? FALLBACK_SCALE;
      const { tone, pct } = classify(x.value, scale);
      return {
        fips: x.state_fips,
        abbr: meta?.abbr ?? `FIPS${x.state_fips}`,
        indicator: x.indicator,
        value: x.value,
        pct,
        tone,
        hint: x.source ?? '',
      };
    });
  }, [indicators, pivotFips, limit]);

  if (rows.length === 0) {
    return (
      <p className={cn('text-[12px] text-[var(--color-fg-subtle)]', className)}>
        No peer indicators received yet.
      </p>
    );
  }

  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {rows.map((row) => {
        const scale = SCALES[row.indicator] ?? FALLBACK_SCALE;
        return (
          <li
            key={`${row.fips}-${row.indicator}`}
            className="grid grid-cols-[44px_minmax(0,1fr)_56px] items-center gap-3"
          >
            <span className="font-mono text-[11px] font-bold tracking-[0.06em] text-[var(--color-fg)]">
              {row.abbr}
            </span>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-1.5">
                <Badge variant="muted" className="text-[9px]">
                  {row.indicator.replaceAll('_', ' ')}
                </Badge>
                {row.hint ? (
                  <span className="font-mono text-[9px] text-[var(--color-fg-subtle)]">
                    {row.hint}
                  </span>
                ) : null}
              </div>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full border border-[var(--color-border)]/60 bg-[var(--color-bg)]">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${Math.max(2, row.pct * 100)}%`, backgroundColor: row.tone }}
                />
                {/* threshold tick (amber) */}
                <span
                  className="absolute top-0 bottom-0 w-px bg-[var(--color-amber)]/70"
                  style={{ left: `${((scale.amberAt - scale.min) / (scale.max - scale.min)) * 100}%` }}
                />
              </div>
            </div>
            <span
              className="text-right font-mono text-[12px] font-semibold tabular-nums"
              style={{ color: row.tone }}
            >
              {row.value.toFixed(scale.suffix ? 1 : 2)}
              {scale.suffix ?? ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
