'use client';

import { Activity } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLayers } from '@/hooks/use-layers';
import { formatTime } from '@/lib/format';
import type {
  FedRatePayload,
  IndicatorPayload,
  ObserverEvent,
  PeerPayload,
} from '@/lib/types';
import { cn } from '@/lib/utils';

interface EventFeedProps {
  events: ObserverEvent[];
}

const KIND_RAIL: Record<string, string> = {
  indicator_received: 'before:bg-[var(--color-cyan)]',
  fed_rate_received: 'before:bg-[var(--color-violet)]',
  peer_update: 'before:bg-[var(--color-amber)]',
  inft_manifest_updated: 'before:bg-[var(--color-emerald)]',
  system_event: 'before:bg-[var(--color-rose)]',
};

const KIND_BADGE: Record<string, 'cyan' | 'violet' | 'amber' | 'emerald' | 'red' | 'muted'> = {
  indicator_received: 'cyan',
  fed_rate_received: 'violet',
  peer_update: 'amber',
  inft_manifest_updated: 'emerald',
  system_event: 'red',
};

function describe(event: ObserverEvent): { title: string; sub?: string } {
  if (event.kind === 'indicator_received') {
    const p = event.payload as IndicatorPayload;
    return {
      title: `${p.indicator?.toUpperCase() ?? 'IND'} ${p.value ?? '?'}`,
      sub: p.source ? `from ${p.source}` : undefined,
    };
  }
  if (event.kind === 'fed_rate_received') {
    const p = event.payload as FedRatePayload;
    return { title: `FED ${p.rate_bps ?? '?'}bps`, sub: p.rationale };
  }
  if (event.kind === 'peer_update') {
    const p = event.payload as PeerPayload;
    return {
      title: `Mesh peers ${p.peer_count ?? 0}`,
      sub: p.observer_pubkey ? `obs ${p.observer_pubkey.slice(0, 10)}…` : undefined,
    };
  }
  if (event.kind === 'inft_manifest_updated') {
    const p = event.payload as { count?: number };
    return { title: 'iNFT manifest sync', sub: `${p.count ?? 0} entries` };
  }
  if (event.kind === 'mesh_snapshot') return { title: 'Mesh snapshot' };
  return { title: event.kind.replaceAll('_', ' ') };
}

export function EventFeed({ events }: EventFeedProps) {
  const { allowedEventKinds } = useLayers();
  const filtered = useMemo(
    () => events.filter((e) => allowedEventKinds.has(e.kind)),
    [events, allowedEventKinds],
  );

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>
          <Activity className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          AXL Live Feed
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {filtered.length}/{events.length}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-full max-h-[260px]">
          <ol className="divide-y divide-[var(--color-border)]">
            {filtered.length === 0 ? (
              <li className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                No events match the active layers.
              </li>
            ) : (
              filtered.map((event) => {
                const { title, sub } = describe(event);
                return (
                  <li
                    key={`${event.id}-${event.timestamp}`}
                    className={cn(
                      'animate-fade-in-up relative pl-3 pr-2.5 py-1.5 text-[12px]',
                      'before:content-[""] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:rounded-r',
                      KIND_RAIL[event.kind] ?? 'before:bg-[var(--color-fg-subtle)]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[var(--color-fg)] truncate">{title}</span>
                      <time className="font-mono text-[10px] text-[var(--color-fg-subtle)] shrink-0">
                        {formatTime(event.timestamp)}
                      </time>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-[11px] text-[var(--color-fg-muted)] truncate">
                        {sub ?? event.kind.replaceAll('_', ' ')}
                      </span>
                      <Badge variant={KIND_BADGE[event.kind] ?? 'muted'} className="shrink-0">
                        {event.kind.split('_')[0]}
                      </Badge>
                    </div>
                  </li>
                );
              })
            )}
          </ol>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
