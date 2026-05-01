'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface TreasuryRow {
  asset: string;
  balance: string;
}

interface TreasuryBarProps {
  composition: TreasuryRow[];
  totalUsd?: number | null;
  /** Decimals to use when decoding base units. Agent state stores all in 6. */
  decimals?: number;
  className?: string;
}

interface AssetTone {
  fill: string;
  bg: string;
  text: string;
}

const ASSET_TONES: Record<string, AssetTone> = {
  USDC: {
    fill: 'var(--color-cyan)',
    bg: 'bg-[var(--color-cyan)]',
    text: 'text-[var(--color-cyan)]',
  },
  TBILL: {
    fill: 'var(--color-violet)',
    bg: 'bg-[var(--color-violet)]',
    text: 'text-[var(--color-violet)]',
  },
  EQUITY: {
    fill: 'var(--color-emerald)',
    bg: 'bg-[var(--color-emerald)]',
    text: 'text-[var(--color-emerald)]',
  },
  BOND: {
    fill: 'var(--color-amber)',
    bg: 'bg-[var(--color-amber)]',
    text: 'text-[var(--color-amber)]',
  },
};

const FALLBACK_TONE: AssetTone = {
  fill: 'var(--color-fg-muted)',
  bg: 'bg-[var(--color-fg-muted)]',
  text: 'text-[var(--color-fg-muted)]',
};

function decode(balance: string, decimals: number): number {
  try {
    const big = BigInt(balance);
    const scale = 10n ** BigInt(decimals);
    const whole = big / scale;
    const frac = big % scale;
    return Number(whole) + Number(frac) / Number(scale);
  } catch {
    return 0;
  }
}

function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function toneFor(asset: string): AssetTone {
  const upper = asset.toUpperCase();
  if (ASSET_TONES[upper]) return ASSET_TONES[upper];
  // State tokens (e.g. MAT, NYT) — give them a stable color from a small palette.
  const seed = [...upper].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const palette = ['amber', 'rose', 'cyan', 'violet', 'emerald'] as const;
  const slot = palette[seed % palette.length] ?? 'amber';
  return {
    fill: `var(--color-${slot})`,
    bg: `bg-[var(--color-${slot})]`,
    text: `text-[var(--color-${slot})]`,
  };
}

export function TreasuryBar({
  composition,
  totalUsd,
  decimals = 6,
  className,
}: TreasuryBarProps) {
  const rows = useMemo(() => {
    const decoded = composition.map((row) => ({
      asset: row.asset,
      raw: row.balance,
      value: decode(row.balance, decimals),
      tone: toneFor(row.asset),
    }));
    const total = decoded.reduce((acc, r) => acc + r.value, 0);
    return decoded.map((row) => ({
      ...row,
      pct: total > 0 ? row.value / total : 0,
    }));
  }, [composition, decimals]);

  const decodedTotal = rows.reduce((acc, r) => acc + r.value, 0);
  const headerValue = totalUsd ?? decodedTotal;

  if (rows.length === 0) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <p className="text-[12px] text-[var(--color-fg-subtle)]">Treasury not yet hydrated.</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
          Total
        </span>
        <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
          {compactUsd(headerValue)}
        </span>
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]">
        {rows.map((row, i) => (
          <div
            key={`${row.asset}-${i}`}
            title={`${row.asset} · ${compactUsd(row.value)} (${(row.pct * 100).toFixed(1)}%)`}
            style={{
              width: `${Math.max(row.pct * 100, 1.5)}%`,
              backgroundColor: row.tone.fill,
            }}
            className="h-full"
          />
        ))}
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((row, i) => (
          <li
            key={`${row.asset}-${i}`}
            className="flex items-center justify-between gap-3 rounded-md bg-[var(--color-bg-soft)]/50 px-2.5 py-1.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: row.tone.fill }}
              />
              <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg)]">
                {row.asset}
              </span>
              <span className={cn('font-mono text-[10px]', row.tone.text)}>
                {(row.pct * 100).toFixed(1)}%
              </span>
            </div>
            <span className="font-mono text-[12px] tabular-nums text-[var(--color-fg-muted)]">
              {compactUsd(row.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
