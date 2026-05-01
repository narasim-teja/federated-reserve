'use client';

import { Brain, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useObserverContext } from '@/hooks/use-observer-context';
import { relativeTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import { cn } from '@/lib/utils';

interface ReflectionTickerProps {
  onSelect?: (fips: number) => void;
  /** When provided, highlights the active state's reflection. */
  selectedFips?: number | null;
}

/**
 * "Agent thoughts" rail. Shows the most recent reflection per agent — the
 * Tier-3 LLM-thesis surface. Cards animate in from the top so judges see
 * agents reasoning live.
 */
export function ReflectionTicker({ onSelect, selectedFips }: ReflectionTickerProps) {
  const { snapshot } = useObserverContext();

  const reflections = useMemo(() => {
    return [...(snapshot?.reflections ?? [])].sort((a, b) =>
      b.emitted_at.localeCompare(a.emitted_at),
    );
  }, [snapshot]);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>
          <Brain className="h-3.5 w-3.5 text-[var(--color-violet)]" />
          Agent thoughts
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {reflections.length}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-full max-h-[280px]">
          {reflections.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-fg-subtle)]" />
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                Waiting for the next reflection cycle…
              </p>
            </div>
          ) : (
            <ol className="flex flex-col">
              {reflections.map((r) => {
                const meta = lookupStateByFips(r.state_fips);
                const active = selectedFips === r.state_fips;
                return (
                  <li key={`${r.state_fips}-${r.emitted_at}`}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(r.state_fips)}
                      className={cn(
                        'group block w-full border-b border-[var(--color-border)] px-3 py-2 text-left transition-colors',
                        active
                          ? 'bg-[var(--color-violet)]/8'
                          : 'hover:bg-[var(--color-surface-elevated)]/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-[10px] font-bold tracking-[0.12em] text-[var(--color-violet)]">
                            {meta?.abbr ?? r.state_abbr}
                          </span>
                          <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                            {meta?.name ?? r.state_abbr} · tick #{r.tick ?? '—'}
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                          {relativeTime(r.emitted_at)}
                        </span>
                      </div>
                      <p className="text-[12px] leading-snug text-[var(--color-fg-muted)] line-clamp-3 group-hover:text-[var(--color-fg)]">
                        {r.summary}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
