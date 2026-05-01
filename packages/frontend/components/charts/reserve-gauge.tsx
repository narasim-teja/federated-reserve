'use client';

import { cn } from '@/lib/utils';

interface ReserveGaugeProps {
  ratio: number | null | undefined;
  /** When provided, label goes here instead of the default. */
  label?: string;
  /** Threshold (lower bound) for amber band — default 0.08 (matches store). */
  amber?: number;
  /** Threshold (lower bound) for green band — default 0.12. */
  green?: number;
  /** Visible upper bound on the gauge sweep (default 0.25 → 25%). */
  max?: number;
  className?: string;
}

const SIZE = 132;
const STROKE = 12;
const CENTER = SIZE / 2;
const RADIUS = CENTER - STROKE - 2;

/** Convert an angle in degrees (0 = right, 90 = up) to an x/y on the radius. */
function point(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CENTER + Math.cos(rad) * RADIUS,
    y: CENTER - Math.sin(rad) * RADIUS,
  };
}

/**
 * SVG path for a circular arc spanning [startAngle, endAngle] in our convention
 * where 180° = leftmost, 0° = rightmost, sweep goes clockwise across the top.
 */
function arcPath(startAngle: number, endAngle: number): string {
  const start = point(startAngle);
  const end = point(endAngle);
  const largeArc = Math.abs(startAngle - endAngle) > 180 ? 1 : 0;
  // sweep flag = 1 → clockwise in SVG screen coords (y is down), which means
  // arcs from leftmost (180°) to rightmost (0°) traverse through the top.
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function ReserveGauge({
  ratio,
  label = 'Reserve ratio',
  amber = 0.08,
  green = 0.12,
  max = 0.25,
  className,
}: ReserveGaugeProps) {
  const value = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : null;
  // Map ratio 0..max to angle 180..0 (left-to-right across the top semicircle).
  const sweepFor = (r: number) => 180 - Math.max(0, Math.min(1, r / max)) * 180;

  const tone =
    value == null
      ? 'var(--color-fg-subtle)'
      : value >= green
        ? 'var(--color-emerald)'
        : value >= amber
          ? 'var(--color-amber)'
          : 'var(--color-red)';

  // Tick markers for amber/green thresholds.
  const ticks = [
    { at: amber, color: 'var(--color-amber)' },
    { at: green, color: 'var(--color-emerald)' },
  ];

  return (
    <div className={cn('flex flex-col items-center gap-1', className)}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE * 0.66}`} className="w-full max-w-[200px]">
        <defs>
          <linearGradient id="reserve-bg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-red)" stopOpacity="0.18" />
            <stop offset={`${(amber / max) * 100}%`} stopColor="var(--color-red)" stopOpacity="0.18" />
            <stop offset={`${(amber / max) * 100}%`} stopColor="var(--color-amber)" stopOpacity="0.22" />
            <stop offset={`${(green / max) * 100}%`} stopColor="var(--color-amber)" stopOpacity="0.22" />
            <stop offset={`${(green / max) * 100}%`} stopColor="var(--color-emerald)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-emerald)" stopOpacity="0.22" />
          </linearGradient>
        </defs>

        {/* background arc */}
        <path
          d={arcPath(180, 0)}
          fill="none"
          stroke="url(#reserve-bg)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />

        {/* threshold ticks */}
        {ticks.map((tick) => {
          const a = sweepFor(tick.at);
          const inner = point(a);
          // Move outward to put tick just outside the arc.
          const outerR = RADIUS + STROKE / 2 + 2;
          const outer = {
            x: CENTER + Math.cos((a * Math.PI) / 180) * outerR,
            y: CENTER - Math.sin((a * Math.PI) / 180) * outerR,
          };
          return (
            <line
              key={tick.at}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={tick.color}
              strokeWidth={1.4}
              strokeLinecap="round"
            />
          );
        })}

        {/* value arc */}
        {value != null ? (
          <path
            d={arcPath(180, sweepFor(value))}
            fill="none"
            stroke={tone}
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        ) : null}

        {/* center number */}
        <text
          x={CENTER}
          y={CENTER + 2}
          textAnchor="middle"
          fontSize="20"
          fontWeight="600"
          fill="var(--color-fg)"
          className="tabular-nums"
        >
          {value == null ? '—' : `${(value * 100).toFixed(1)}%`}
        </text>
      </svg>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="flex items-center gap-2 font-mono text-[9px] text-[var(--color-fg-subtle)]">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-red)]" />
          stress &lt;{(amber * 100).toFixed(0)}%
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-amber)]" />
          watch
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-emerald)]" />
          healthy ≥{(green * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
