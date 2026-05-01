'use client';

import { cn } from '@/lib/utils';

const ITEMS: Array<{ label: string; tone: 'red' | 'amber' | 'emerald' | 'violet' | 'cyan' | 'muted'; shape?: 'dot' | 'pulse' | 'square' }>
  = [
    { label: 'High alert', tone: 'red', shape: 'dot' },
    { label: 'Elevated', tone: 'amber', shape: 'dot' },
    { label: 'Healthy', tone: 'emerald', shape: 'dot' },
    { label: 'Idle', tone: 'muted', shape: 'dot' },
    { label: 'Deep agent', tone: 'violet', shape: 'square' },
    { label: 'Live event', tone: 'cyan', shape: 'pulse' },
  ];

const TONE_BG: Record<string, string> = {
  red: 'bg-[var(--color-red)]',
  amber: 'bg-[var(--color-amber)]',
  emerald: 'bg-[var(--color-emerald)]',
  violet: 'bg-[var(--color-violet)]',
  cyan: 'bg-[var(--color-cyan)]',
  muted: 'bg-[var(--color-fg-subtle)]/60',
};

export function MapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
      <span className="text-[var(--color-fg-subtle)]">Legend</span>
      {ITEMS.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              item.shape === 'square' ? 'h-2 w-2 rounded-[2px]' : 'h-2 w-2 rounded-full',
              TONE_BG[item.tone],
              item.shape === 'pulse' && 'animate-pulse',
            )}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
