'use client';

import { useStateLookup, useUsAtlas } from '@/hooks/use-us-atlas';
import { lookupStateByFips } from '@/lib/states';
import type { Health, StateView, SwapEvent } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const VIEWBOX_W = 975;
const VIEWBOX_H = 610;
const MIN_VB_W = VIEWBOX_W / 6;
const ASPECT = VIEWBOX_H / VIEWBOX_W;
const DEFAULT_VB = { x: 0, y: 0, w: VIEWBOX_W, h: VIEWBOX_H };

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clampVb(v: ViewBox): ViewBox {
  const w = Math.max(MIN_VB_W, Math.min(VIEWBOX_W, v.w));
  const h = w * ASPECT;
  const x = Math.max(0, Math.min(VIEWBOX_W - w, v.x));
  const y = Math.max(0, Math.min(VIEWBOX_H - h, v.y));
  return { x, y, w, h };
}

function zoomCentered(v: ViewBox, factor: number): ViewBox {
  const cx = v.x + v.w / 2;
  const cy = v.y + v.h / 2;
  const w = v.w * factor;
  const h = w * ASPECT;
  return clampVb({ x: cx - w / 2, y: cy - h / 2, w, h });
}

function compactAmount(raw: string, asset: string): string {
  // USDC and StateTokens both use 6 decimals in agent state. Strip them and
  // render in a human-readable compact form.
  try {
    const big = BigInt(raw);
    const scaled = Number(big) / 1e6;
    if (scaled >= 1_000_000) return `${(scaled / 1_000_000).toFixed(2)}M ${asset}`;
    if (scaled >= 1_000) return `${(scaled / 1_000).toFixed(0)}k ${asset}`;
    return `${scaled.toFixed(2)} ${asset}`;
  } catch {
    return `${raw} ${asset}`;
  }
}

interface GeoMapProps {
  states: StateView[];
  selectedFips: number | null;
  hoveredFips?: number | null;
  onSelect: (fips: number) => void;
  onHover?: (fips: number | null) => void;
  /** Map of fips → monotonic counter; flashes a ring when the value changes. */
  pulseFor: Record<number, number>;
  /** When true, dim observer-tier states. */
  deepOnly: boolean;
  /** Capital-flow arcs to animate; each fades after ~3s. */
  arcs?: (SwapEvent & { id: number })[];
  onArcExpire?: (id: number) => void;
}

const FILL: Record<Health, string> = {
  green:
    'fill-[color-mix(in_oklch,var(--color-emerald)_22%,transparent)] hover:fill-[color-mix(in_oklch,var(--color-emerald)_36%,transparent)]',
  amber:
    'fill-[color-mix(in_oklch,var(--color-amber)_24%,transparent)] hover:fill-[color-mix(in_oklch,var(--color-amber)_38%,transparent)]',
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

export function GeoMap({
  states,
  selectedFips,
  hoveredFips,
  onSelect,
  onHover,
  pulseFor,
  deepOnly,
  arcs,
  onArcExpire,
}: GeoMapProps) {
  const { data: atlas, error } = useUsAtlas();
  const lookup = useStateLookup(atlas);

  // Zoom & pan state
  const containerRef = useRef<HTMLDivElement>(null);
  const [vb, setVb] = useState<ViewBox>(DEFAULT_VB);
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ cx: 0, cy: 0, vbx: 0, vby: 0, moved: false });
  const isZoomed = vb.w < VIEWBOX_W - 1;

  // Wheel zoom centered on mouse — needs a native listener so we can
  // preventDefault (React's onWheel is passive in newer React).
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setVb((v) => {
        const factor = e.deltaY < 0 ? 0.85 : 1.18;
        const newW = Math.max(MIN_VB_W, Math.min(VIEWBOX_W, v.w * factor));
        const newH = newW * ASPECT;
        // Mouse position in viewBox coords (before zoom)
        const vx = v.x + (mx / rect.width) * v.w;
        const vy = v.y + (my / rect.height) * v.h;
        const newX = vx - (mx / rect.width) * newW;
        const newY = vy - (my / rect.height) * newH;
        return clampVb({ x: newX, y: newY, w: newW, h: newH });
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (vbRef.current.w >= VIEWBOX_W - 1) return; // no pan when fully zoomed out
    isPanningRef.current = true;
    panStartRef.current = {
      cx: e.clientX,
      cy: e.clientY,
      vbx: vbRef.current.x,
      vby: vbRef.current.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanningRef.current) return;
    const node = containerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const dx = e.clientX - panStartRef.current.cx;
    const dy = e.clientY - panStartRef.current.cy;
    if (!panStartRef.current.moved && Math.hypot(dx, dy) > 4) {
      panStartRef.current.moved = true;
    }
    setVb((v) => {
      const dvx = (dx / rect.width) * v.w;
      const dvy = (dy / rect.height) * v.h;
      return clampVb({
        x: panStartRef.current.vbx - dvx,
        y: panStartRef.current.vby - dvy,
        w: v.w,
        h: v.h,
      });
    });
  }, []);

  const endPan = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }, []);

  // Suppress state click if a pan drag just happened.
  const onStateClick = useCallback(
    (fips: number) => {
      if (panStartRef.current.moved) {
        panStartRef.current.moved = false;
        return;
      }
      onSelect(fips);
    },
    [onSelect],
  );

  const zoomIn = useCallback(() => setVb((v) => zoomCentered(v, 0.7)), []);
  const zoomOut = useCallback(() => setVb((v) => zoomCentered(v, 1.4)), []);
  const reset = useCallback(() => setVb(DEFAULT_VB), []);

  useEffect(() => {
    if (!arcs || arcs.length === 0 || !onArcExpire) return;
    const timers = arcs.map((arc) => setTimeout(() => onArcExpire(arc.id), 3200));
    return () => timers.forEach(clearTimeout);
  }, [arcs, onArcExpire]);

  const stateByFips = useMemo(() => {
    const m = new Map<number, StateView>();
    for (const s of states) m.set(s.fips, s);
    return m;
  }, [states]);

  const pulses = useMemo(() => {
    if (!atlas)
      return [] as Array<{ fips: number; cx: number; cy: number; key: number; health: Health }>;
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
      .filter(Boolean) as Array<{
      fips: number;
      cx: number;
      cy: number;
      key: number;
      health: Health;
    }>;
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

  // Convert atlas viewBox coords → percent of the *current* viewBox so HTML
  // overlay labels track zoom/pan correctly.
  const toLeftPct = (x: number) => ((x - vb.x) / vb.w) * 100;
  const toTopPct = (y: number) => ((y - vb.y) / vb.h) * 100;

  const cursorClass = isZoomed ? (isPanningRef.current ? 'cursor-grabbing' : 'cursor-grab') : '';

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden touch-none">
      <div className="absolute inset-0 grid-bg pointer-events-none opacity-50" />
      <svg
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn('relative h-full w-full select-none', cursorClass)}
        role="img"
        aria-label="US state mesh map"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <defs>
          <filter id="state-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>

        {/* Country border halo */}
        <path
          d={atlas.borderD}
          className="fill-none stroke-[var(--color-cyan)]/25"
          strokeWidth={3}
          filter="url(#state-glow)"
        />

        {/* States */}
        <g>
          {atlas.states.map((feat) => {
            const data = stateByFips.get(feat.fips);
            const health: Health = data?.health ?? 'unknown';
            const isSelected = selectedFips === feat.fips;
            const isHovered = hoveredFips === feat.fips;
            const dimmed = deepOnly && data?.tier !== 'deep';
            return (
              <path
                key={feat.id}
                d={feat.d}
                onClick={() => onStateClick(feat.fips)}
                onMouseEnter={() => onHover?.(feat.fips)}
                onMouseLeave={() => onHover?.(null)}
                className={cn(
                  'cursor-pointer transition-[fill,stroke,opacity] duration-200',
                  FILL[health],
                  STROKE[health],
                  isSelected &&
                    'fill-[color-mix(in_oklch,var(--color-cyan)_30%,transparent)] stroke-[var(--color-cyan)]',
                  isHovered && !isSelected && 'stroke-[var(--color-amber)] opacity-100',
                  dimmed && 'opacity-25',
                )}
                strokeWidth={isSelected ? 1.4 : isHovered ? 1.1 : 0.6}
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
              <circle cx={cx} cy={cy} r={4} fill={PULSE_COLOR[health]} opacity={0.7}>
                <animate attributeName="r" from={4} to={22} dur="1.6s" repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  from={0.7}
                  to={0}
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle cx={cx} cy={cy} r={2.5} fill={PULSE_COLOR[health]} />
            </g>
          ))}
        </g>

        {/* Capital-flow arcs */}
        {arcs && arcs.length > 0 && (
          <g>
            {arcs.map((arc) => {
              const from = lookup.get(arc.from_fips);
              const to = lookup.get(arc.to_fips);
              if (!from || !to) return null;
              const [x1, y1] = from.centroid;
              const [x2, y2] = to.centroid;
              // Quadratic bezier with curve height proportional to distance.
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              const dx = x2 - x1;
              const dy = y2 - y1;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const norm = dist === 0 ? 1 : dist;
              const cx = mx - (dy / norm) * Math.min(80, dist * 0.35);
              const cy = my + (dx / norm) * Math.min(80, dist * 0.35);
              const path = `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
              const length = Math.round(dist * 1.5 + 200);
              return (
                <g key={arc.id}>
                  <path
                    d={path}
                    fill="none"
                    stroke="var(--color-emerald)"
                    strokeOpacity={0.9}
                    strokeWidth={1.4}
                    strokeDasharray={`${length}`}
                    strokeDashoffset={length}
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from={length}
                      to={0}
                      dur="1.6s"
                      fill="freeze"
                    />
                    <animate
                      attributeName="stroke-opacity"
                      values="0.9;0.9;0"
                      keyTimes="0;0.6;1"
                      dur="3s"
                      fill="freeze"
                    />
                  </path>
                  <circle r={3} fill="var(--color-emerald)">
                    <animateMotion dur="1.6s" path={path} fill="freeze" />
                    <animate
                      attributeName="opacity"
                      values="1;1;0"
                      keyTimes="0;0.7;1"
                      dur="2.6s"
                      fill="freeze"
                    />
                  </circle>
                </g>
              );
            })}
          </g>
        )}
      </svg>

      {/* Capital-flow labels — HTML overlay so the typography sits above SVG */}
      {arcs && arcs.length > 0 && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {arcs.map((arc) => {
            const to = lookup.get(arc.to_fips);
            if (!to) return null;
            const fromMeta = lookupStateByFips(arc.from_fips);
            const toMeta = lookupStateByFips(arc.to_fips);
            const left = toLeftPct(to.centroid[0]);
            const top = toTopPct(to.centroid[1]);
            if (left < -10 || left > 110 || top < -10 || top > 110) return null;
            const give = arc.give ? compactAmount(arc.give.amount, arc.give.asset) : null;
            return (
              <div
                key={`label-${arc.id}`}
                style={{ left: `${left}%`, top: `${top}%` }}
                className="absolute -translate-x-1/2 -translate-y-[140%] animate-fade-in-up"
              >
                <div className="rounded-md border border-[var(--color-emerald)]/50 bg-[var(--color-bg)]/85 backdrop-blur px-2 py-1 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.6)]">
                  <div className="flex items-center gap-1 font-mono text-[10px] font-bold tracking-[0.06em] text-[var(--color-fg)]">
                    <span>{fromMeta?.abbr ?? `FIPS${arc.from_fips}`}</span>
                    <span className="text-[var(--color-emerald)]">→</span>
                    <span>{toMeta?.abbr ?? `FIPS${arc.to_fips}`}</span>
                  </div>
                  {give ? (
                    <div className="font-mono text-[10px] tabular-nums text-[var(--color-emerald)]">
                      {give}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <ZoomBtn onClick={zoomIn} ariaLabel="Zoom in" disabled={vb.w <= MIN_VB_W + 1}>
          <Plus className="h-3.5 w-3.5" />
        </ZoomBtn>
        <ZoomBtn onClick={zoomOut} ariaLabel="Zoom out" disabled={!isZoomed}>
          <Minus className="h-3.5 w-3.5" />
        </ZoomBtn>
        <ZoomBtn onClick={reset} ariaLabel="Reset view" disabled={!isZoomed}>
          <RotateCcw className="h-3.5 w-3.5" />
        </ZoomBtn>
      </div>
    </div>
  );
}

function ZoomBtn({
  children,
  onClick,
  ariaLabel,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg)]/85 text-[var(--color-fg-muted)] backdrop-blur transition-colors',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] cursor-pointer',
      )}
    >
      {children}
    </button>
  );
}
