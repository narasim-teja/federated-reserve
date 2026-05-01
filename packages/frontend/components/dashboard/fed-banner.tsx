'use client';

import { Landmark, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatTime, relativeTime } from '@/lib/format';
import type { Snapshot } from '@/lib/types';

interface FedBannerProps {
  snapshot: Snapshot | null;
}

export function FedBanner({ snapshot }: FedBannerProps) {
  const fed = snapshot?.latest_fed_rate;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-gradient-to-r from-[color-mix(in_oklch,var(--color-violet)_12%,transparent)] via-[var(--color-surface)]/40 to-[color-mix(in_oklch,var(--color-cyan)_8%,transparent)] px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-violet)]/15 text-[var(--color-violet)] glow-violet">
        <Landmark className="h-4 w-4" />
      </span>
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          Latest Federal Reserve broadcast
        </span>
        {fed ? (
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-lg font-semibold tabular-nums">{fed.rate_bps}bps</span>
            <span className="text-xs text-[var(--color-fg-muted)] truncate">{fed.rationale}</span>
          </div>
        ) : (
          <span className="text-sm text-[var(--color-fg-subtle)] mt-0.5">
            Awaiting first FED rate broadcast…
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {fed && (
          <Badge variant="violet">
            <TrendingUp className="h-3 w-3" />
            {formatTime(fed.received_at)}
          </Badge>
        )}
        <Badge variant="muted" className="font-mono">
          mesh {relativeTime(snapshot?.mesh.last_refresh_at ?? null)}
        </Badge>
      </div>
    </div>
  );
}
