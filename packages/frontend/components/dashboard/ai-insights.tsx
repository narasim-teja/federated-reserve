'use client';

import { Brain, Flame, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime, relativeTime } from '@/lib/format';
import { rankInstability } from '@/lib/instability';
import type { Region, Snapshot } from '@/lib/types';

interface AiInsightsProps {
  snapshot: Snapshot | null;
}

export function AiInsightsPanel({ snapshot }: AiInsightsProps) {
  const ranked = useMemo(
    () => (snapshot ? rankInstability(snapshot.states, 5) : []),
    [snapshot],
  );

  const focal = useMemo(() => {
    if (!ranked.length) return null;
    const byRegion = new Map<Region, number>();
    for (const r of ranked) {
      const region = r.state.region;
      byRegion.set(region, (byRegion.get(region) ?? 0) + r.total);
    }
    let topRegion: Region = 'south';
    let topScore = -1;
    for (const [region, score] of byRegion) {
      if (score > topScore) {
        topScore = score;
        topRegion = region;
      }
    }
    return { region: topRegion, score: Math.round(topScore / ranked.length) };
  }, [ranked]);

  const fed = snapshot?.latest_fed_rate;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Brain className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          AI Insights
        </CardTitle>
        <Badge variant="emerald">LIVE</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <article className="rounded-md border border-[color-mix(in_oklch,var(--color-cyan)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-cyan)_8%,transparent)] p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
              Mesh Brief
            </span>
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
              {relativeTime(snapshot?.generated_at ?? null)}
            </span>
          </div>
          <p className="text-[12px] leading-snug text-[var(--color-fg)]">
            {fed ? (
              <>
                Federal Reserve set policy at{' '}
                <span className="font-mono text-[var(--color-violet)]">{fed.rate_bps}bps</span>.{' '}
                {fed.rationale}
              </>
            ) : (
              'Mesh online; awaiting initial Federal Reserve broadcast and indicator fan-out from the data plane.'
            )}
          </p>
        </article>

        {focal && (
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-fg-muted)] mb-1.5">
              Focal Points
            </div>
            <div className="flex flex-col gap-1.5">
              <FocalRow
                label={focal.region.toUpperCase()}
                score={focal.score}
                tone={focal.score >= 60 ? 'critical' : focal.score >= 40 ? 'warn' : 'norm'}
                hint="region-aggregate stress"
              />
              {fed && (
                <FocalRow
                  label="FED"
                  score={Math.round((fed.rate_bps / 600) * 100)}
                  tone="info"
                  hint={formatTime(fed.received_at)}
                  icon={<Zap className="h-3 w-3" />}
                />
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FocalRow({
  label,
  score,
  tone,
  hint,
  icon,
}: {
  label: string;
  score: number;
  tone: 'critical' | 'warn' | 'norm' | 'info';
  hint?: string;
  icon?: React.ReactNode;
}) {
  const toneClasses = {
    critical:
      'border-[color-mix(in_oklch,var(--color-red)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-red)_18%,transparent)]',
    warn: 'border-[color-mix(in_oklch,var(--color-amber)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-amber)_15%,transparent)]',
    norm: 'border-[var(--color-border)] bg-[var(--color-surface)]/50',
    info: 'border-[color-mix(in_oklch,var(--color-cyan)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-cyan)_12%,transparent)]',
  }[tone];
  const labelTone = {
    critical: 'text-[var(--color-red)]',
    warn: 'text-[var(--color-amber)]',
    norm: 'text-[var(--color-fg)]',
    info: 'text-[var(--color-cyan)]',
  }[tone];
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-md border ${toneClasses} px-3 py-1.5`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {icon ?? <Flame className={`h-3 w-3 ${labelTone}`} />}
        <span className={`font-mono text-[11px] font-bold ${labelTone}`}>{label}</span>
        {hint && (
          <span className="font-mono text-[10px] text-[var(--color-fg-subtle)] truncate">
            {hint}
          </span>
        )}
      </div>
      <span
        className={`font-mono text-[11px] font-bold tabular-nums ${labelTone}`}
        title="composite score"
      >
        {score}
      </span>
    </div>
  );
}
