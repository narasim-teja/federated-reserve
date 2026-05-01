'use client';

import { CloudLightning } from 'lucide-react';
import { useObserverContext } from '@/hooks/use-observer-context';
import { lookupStateByFips } from '@/lib/states';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';

/**
 * NOAA shock ticker. Renders only when the FED has injected at least one
 * shock event into the mesh. Pulses red when severity ≥ 7.
 */
export function ShockRibbon({ className }: { className?: string }) {
  const { snapshot } = useObserverContext();
  const shocks = snapshot?.shocks ?? [];
  if (shocks.length === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-3 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-rose)]/8 px-3 py-1.5',
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-rose)]">
        <CloudLightning className="h-3.5 w-3.5" />
        NOAA shock feed
      </span>
      <div className="flex-1 overflow-hidden">
        <div className="flex items-center gap-3 whitespace-nowrap text-[11px] font-mono">
          {shocks.slice(0, 8).map((s, i) => {
            const meta = lookupStateByFips(s.state_fips);
            const tone =
              s.severity >= 7
                ? 'text-[var(--color-red)]'
                : s.severity >= 4
                  ? 'text-[var(--color-amber)]'
                  : 'text-[var(--color-fg-muted)]';
            return (
              <span key={`${s.state_fips}-${s.event_type}-${i}`} className="inline-flex items-center gap-1.5">
                <span className={cn('font-bold', tone)}>{meta?.abbr ?? `FIPS${s.state_fips}`}</span>
                <span className="text-[var(--color-fg-muted)]">
                  {s.event_type.replaceAll('_', ' ')}
                </span>
                <span className="text-[var(--color-fg-subtle)]">sev {s.severity}/10</span>
                <span className="text-[var(--color-fg-subtle)]">· {relativeTime(s.emitted_at)}</span>
                {i < shocks.length - 1 && <span className="text-[var(--color-fg-subtle)]">·</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
