'use client';

import { Handshake, MessagesSquare } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { NegotiationModal } from '@/components/dashboard/negotiation-modal';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useObserverContext } from '@/hooks/use-observer-context';
import { relativeTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import type { NegotiationView } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function NegotiationsPage() {
  return (
    <Suspense fallback={<NegotiationsFallback />}>
      <NegotiationsContent />
    </Suspense>
  );
}

function NegotiationsFallback() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
        Loading negotiations…
      </p>
    </div>
  );
}

function NegotiationsContent() {
  const { snapshot } = useObserverContext();
  const searchParams = useSearchParams();
  const queryTask = searchParams?.get('task') ?? null;
  const [active, setActive] = useState<string | null>(queryTask);
  const [filter, setFilter] = useState<'all' | 'open' | 'settled' | 'rejected'>('all');

  useEffect(() => {
    if (queryTask) setActive(queryTask);
  }, [queryTask]);

  const negotiations = useMemo(() => {
    const all = snapshot?.negotiations ?? [];
    if (filter === 'all') return all;
    return all.filter((n) => n.status === filter);
  }, [snapshot, filter]);

  const counts = useMemo(() => {
    const all = snapshot?.negotiations ?? [];
    return {
      all: all.length,
      open: all.filter((n) => n.status === 'open').length,
      settled: all.filter((n) => n.status === 'settled').length,
      rejected: all.filter((n) => n.status === 'rejected').length,
    };
  }, [snapshot]);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto max-w-[1200px]">
        <Card>
          <CardHeader>
            <CardTitle>
              <MessagesSquare className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
              Active negotiations
            </CardTitle>
            <div className="flex items-center gap-1">
              {(['all', 'open', 'settled', 'rejected'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={cn(
                    'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
                    filter === key
                      ? 'border-[var(--color-cyan)] bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]'
                      : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                  )}
                >
                  {key} <span className="text-[var(--color-fg-subtle)]">{counts[key]}</span>
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[70vh]">
              {negotiations.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <Handshake className="h-5 w-5 text-[var(--color-fg-subtle)]" />
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                    No matching negotiations yet
                  </p>
                  <p className="text-[12px] text-[var(--color-fg-muted)]">
                    Threads appear here as agents propose, counter, accept, or settle.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {negotiations.map((view) => (
                    <NegotiationRow key={view.task_id} view={view} onOpen={() => setActive(view.task_id)} />
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
      <NegotiationModal taskId={active} onClose={() => setActive(null)} />
    </div>
  );
}

function NegotiationRow({ view, onOpen }: { view: NegotiationView; onOpen: () => void }) {
  const last = view.rounds[view.rounds.length - 1];
  const tone =
    view.status === 'settled' ? 'emerald' : view.status === 'rejected' ? 'red' : 'cyan';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full px-4 py-3 text-left hover:bg-[var(--color-surface-elevated)]/30"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant={tone}>{view.status}</Badge>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              {view.skill}
            </span>
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
              · {view.rounds.length} rounds
            </span>
          </div>
          <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
            {relativeTime(view.last_at)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--color-fg)]">
          {view.participants.map((fips, i) => {
            const meta = lookupStateByFips(fips);
            return (
              <span key={`${fips}-${i}`} className="font-mono font-bold">
                {meta?.abbr ?? `FIPS${fips}`}
                {i < view.participants.length - 1 ? (
                  <span className="text-[var(--color-fg-subtle)]"> ⇄ </span>
                ) : null}
              </span>
            );
          })}
        </div>
        <p className="mt-1 line-clamp-2 text-[12px] text-[var(--color-fg-muted)]">
          {last?.summary ?? 'no rounds yet'}
        </p>
      </button>
    </li>
  );
}
