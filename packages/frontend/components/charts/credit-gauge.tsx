'use client';

import { cn } from '@/lib/utils';

interface CreditGaugeProps {
  rating: string;
  score: number;
  yieldFloorBps: number;
  yieldCeilingBps: number;
  summary?: string;
  className?: string;
}

interface BandTier {
  label: string;
  /** Lower bound of the score band (inclusive). */
  threshold: number;
  tone: string;
}

/**
 * Buckets pulled from packages/shared/src/credit-rating.ts. Kept compressed
 * to fit on the gauge — investment-grade vs speculative is the demo signal.
 */
const BANDS: BandTier[] = [
  { label: 'D',   threshold: 0,  tone: 'var(--color-red)' },
  { label: 'C',   threshold: 15, tone: 'var(--color-red)' },
  { label: 'B',   threshold: 25, tone: 'var(--color-rose)' },
  { label: 'BB',  threshold: 35, tone: 'var(--color-amber)' },
  { label: 'BBB', threshold: 45, tone: 'var(--color-amber)' },
  { label: 'A',   threshold: 60, tone: 'var(--color-cyan)' },
  { label: 'AA',  threshold: 75, tone: 'var(--color-emerald)' },
  { label: 'AAA', threshold: 90, tone: 'var(--color-emerald)' },
];

const RATING_TONE: Record<string, string> = {
  AAA: 'text-[var(--color-emerald)]',
  'AA+': 'text-[var(--color-emerald)]',
  AA: 'text-[var(--color-emerald)]',
  'AA-': 'text-[var(--color-emerald)]',
  'A+': 'text-[var(--color-cyan)]',
  A: 'text-[var(--color-cyan)]',
  'A-': 'text-[var(--color-cyan)]',
  'BBB+': 'text-[var(--color-amber)]',
  BBB: 'text-[var(--color-amber)]',
  'BBB-': 'text-[var(--color-amber)]',
  BB: 'text-[var(--color-amber)]',
  B: 'text-[var(--color-rose)]',
  C: 'text-[var(--color-red)]',
  D: 'text-[var(--color-red)]',
};

export function CreditGauge({
  rating,
  score,
  yieldFloorBps,
  yieldCeilingBps,
  summary,
  className,
}: CreditGaugeProps) {
  const clamped = Math.max(0, Math.min(100, score));
  const ratingTone = RATING_TONE[rating] ?? 'text-[var(--color-fg)]';

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            Rating
          </div>
          <div className={cn('font-mono text-3xl font-bold leading-none', ratingTone)}>{rating}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            Score
          </div>
          <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
            {clamped.toFixed(1)}
            <span className="ml-0.5 text-[10px] text-[var(--color-fg-subtle)]">/100</span>
          </div>
        </div>
      </div>

      <div className="relative">
        {/* Banded track */}
        <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-[var(--color-border)]">
          {BANDS.map((band, i) => {
            const next = BANDS[i + 1];
            const upper = next?.threshold ?? 100;
            const widthPct = upper - band.threshold;
            return (
              <div
                key={band.label}
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: `color-mix(in oklch, ${band.tone} 35%, transparent)`,
                }}
                className="h-full"
              />
            );
          })}
        </div>
        {/* Score marker */}
        <div
          className="absolute -top-1 h-4 w-[3px] rounded-full bg-[var(--color-fg)] shadow-[0_0_0_1.5px_var(--color-bg)]"
          style={{ left: `calc(${clamped}% - 1.5px)` }}
        />
        {/* Tier labels */}
        <div className="mt-1 flex w-full font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          {BANDS.map((band, i) => {
            const next = BANDS[i + 1];
            const upper = next?.threshold ?? 100;
            const widthPct = upper - band.threshold;
            return (
              <span
                key={`label-${band.label}`}
                className="text-center"
                style={{ width: `${widthPct}%` }}
              >
                {band.label}
              </span>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <YieldStat label="Yield floor" valueBps={yieldFloorBps} tone="cyan" />
        <YieldStat label="Yield ceiling" valueBps={yieldCeilingBps} tone="rose" />
      </div>

      {summary ? (
        <p className="text-[11px] leading-snug text-[var(--color-fg-subtle)]">{summary}</p>
      ) : null}
    </div>
  );
}

function YieldStat({
  label,
  valueBps,
  tone,
}: {
  label: string;
  valueBps: number;
  tone: 'cyan' | 'rose' | 'amber' | 'emerald';
}) {
  const toneClass = {
    cyan: 'text-[var(--color-cyan)] border-[var(--color-cyan)]/40',
    rose: 'text-[var(--color-rose)] border-[var(--color-rose)]/40',
    amber: 'text-[var(--color-amber)] border-[var(--color-amber)]/40',
    emerald: 'text-[var(--color-emerald)] border-[var(--color-emerald)]/40',
  }[tone];
  return (
    <div className={cn('rounded-md border bg-[var(--color-bg-soft)]/40 px-2.5 py-2', toneClass)}>
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="font-mono text-base font-semibold tabular-nums">
        {(valueBps / 100).toFixed(2)}
        <span className="ml-0.5 text-[10px] text-[var(--color-fg-subtle)]">%</span>
      </div>
      <div className="font-mono text-[9px] text-[var(--color-fg-subtle)]">{valueBps} bps</div>
    </div>
  );
}
