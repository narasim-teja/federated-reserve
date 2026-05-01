'use client';

import { useMemo } from 'react';
import { useStateLookup, useUsAtlas } from '@/hooks/use-us-atlas';
import { lookupStateByAbbr } from '@/lib/states';
import type { Health } from '@/lib/types';
import { cn } from '@/lib/utils';

interface StateSilhouetteProps {
  abbr: string;
  health?: Health;
  /** Variant changes the visual treatment. */
  variant?: 'avatar' | 'watermark';
  className?: string;
  /** Pixel size for `avatar`. Watermark fills its container. */
  size?: number;
}

const HEALTH_FILL: Record<Health, string> = {
  green: 'color-mix(in oklch, var(--color-emerald) 32%, transparent)',
  amber: 'color-mix(in oklch, var(--color-amber) 32%, transparent)',
  red: 'color-mix(in oklch, var(--color-red) 32%, transparent)',
  unknown: 'color-mix(in oklch, var(--color-cyan) 18%, transparent)',
};

const HEALTH_STROKE: Record<Health, string> = {
  green: 'var(--color-emerald)',
  amber: 'var(--color-amber)',
  red: 'var(--color-red)',
  unknown: 'var(--color-cyan)',
};

/**
 * Renders just one US state as an isolated silhouette, cropped to its
 * bounding box and tinted by health. Identity-first visual: every agent
 * dossier looks distinct because every state's outline is different.
 */
export function StateSilhouette({
  abbr,
  health = 'unknown',
  variant = 'avatar',
  className,
  size = 120,
}: StateSilhouetteProps) {
  const meta = lookupStateByAbbr(abbr);
  const { data: atlas } = useUsAtlas();
  const lookup = useStateLookup(atlas);
  const feature = meta ? lookup.get(meta.fips) : undefined;

  const viewBox = useMemo(() => {
    if (!feature) return null;
    const [[minX, minY], [maxX, maxY]] = feature.bbox;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // 6% padding so the stroke isn't clipped.
    const pad = Math.max(w, h) * 0.06;
    return {
      x: minX - pad,
      y: minY - pad,
      w: w + pad * 2,
      h: h + pad * 2,
    };
  }, [feature]);

  if (!feature || !viewBox) {
    return (
      <div
        className={cn(
          variant === 'avatar'
            ? 'flex shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/40'
            : 'absolute inset-0',
          className,
        )}
        style={
          variant === 'avatar' ? { width: size, height: size } : undefined
        }
      >
        <span className="font-mono text-[10px] tracking-[0.16em] text-[var(--color-fg-subtle)]">
          —
        </span>
      </div>
    );
  }

  const stroke = HEALTH_STROKE[health];
  const fill = HEALTH_FILL[health];
  const filterId = `silhouette-glow-${abbr}`;
  const gradId = `silhouette-grad-${abbr}-${variant}`;
  const isWatermark = variant === 'watermark';

  return (
    <div
      className={cn(
        isWatermark
          ? 'pointer-events-none absolute inset-0 flex items-center justify-end overflow-hidden'
          : 'flex shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-soft)]/30',
        className,
      )}
      style={!isWatermark ? { width: size, height: size } : undefined}
    >
      <svg
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        className={cn(
          isWatermark ? 'h-[180%] w-auto -translate-y-2 opacity-25 blur-[0.2px]' : 'h-full w-full',
        )}
        role="img"
        aria-label={`${meta?.name ?? abbr} silhouette`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={isWatermark ? 0.9 : 0.6} />
            <stop offset="100%" stopColor={stroke} stopOpacity={isWatermark ? 0.5 : 0.3} />
          </linearGradient>
          <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation={isWatermark ? 1.6 : 0.8} />
          </filter>
        </defs>
        {/* glow halo */}
        <path d={feature.d} fill={fill} filter={`url(#${filterId})`} />
        {/* primary outline */}
        <path
          d={feature.d}
          fill={fill}
          stroke={`url(#${gradId})`}
          strokeWidth={isWatermark ? 1.2 : 0.9}
          strokeLinejoin="round"
        />
        {!isWatermark ? (
          <text
            x={(viewBox.x + viewBox.w / 2).toString()}
            y={(viewBox.y + viewBox.h / 2 + (viewBox.h / 16)).toString()}
            textAnchor="middle"
            fontSize={Math.max(viewBox.w, viewBox.h) * 0.22}
            fontWeight={700}
            fill="var(--color-fg)"
            className="font-mono"
            opacity={0.92}
            style={{ paintOrder: 'stroke', stroke: 'var(--color-bg)', strokeWidth: 1.5 }}
          >
            {abbr}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
