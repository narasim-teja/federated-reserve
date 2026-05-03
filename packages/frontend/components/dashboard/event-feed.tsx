'use client';

import {
  Activity,
  ArrowLeftRight,
  CloudLightning,
  Handshake,
  Landmark,
  Radio,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLayers } from '@/hooks/use-layers';
import { compactHash, formatTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import type {
  FedRatePayload,
  IndicatorPayload,
  NegotiationRound,
  ObserverEvent,
  PeerPayload,
  ReflectionEvent,
  ShockEvent,
  SwapEvent,
} from '@/lib/types';
import { cn } from '@/lib/utils';

interface EventFeedProps {
  events: ObserverEvent[];
  onSelectFips?: (fips: number) => void;
  onSelectNegotiation?: (taskId: string) => void;
}

interface EventVisuals {
  icon: React.ReactNode;
  rail: string;
  badge: 'cyan' | 'violet' | 'amber' | 'emerald' | 'red' | 'rose' | 'muted';
  label: string;
}

const VISUALS: Record<string, EventVisuals> = {
  indicator_received: {
    icon: <Radio className="h-3 w-3" />,
    rail: 'bg-[var(--color-cyan)]',
    badge: 'cyan',
    label: 'indicator',
  },
  fed_rate_received: {
    icon: <Landmark className="h-3 w-3" />,
    rail: 'bg-[var(--color-violet)]',
    badge: 'violet',
    label: 'fed',
  },
  peer_update: {
    icon: <Sparkles className="h-3 w-3" />,
    rail: 'bg-[var(--color-amber)]',
    badge: 'amber',
    label: 'peer',
  },
  inft_manifest_updated: {
    icon: <ScrollText className="h-3 w-3" />,
    rail: 'bg-[var(--color-emerald)]',
    badge: 'emerald',
    label: 'inft',
  },
  negotiation_round: {
    icon: <Handshake className="h-3 w-3" />,
    rail: 'bg-[var(--color-cyan)]',
    badge: 'cyan',
    label: 'a2a',
  },
  swap_executed: {
    icon: <ArrowLeftRight className="h-3 w-3" />,
    rail: 'bg-[var(--color-emerald)]',
    badge: 'emerald',
    label: 'swap',
  },
  shock_injected: {
    icon: <CloudLightning className="h-3 w-3" />,
    rail: 'bg-[var(--color-rose)]',
    badge: 'rose',
    label: 'shock',
  },
  reflection: {
    icon: <Activity className="h-3 w-3" />,
    rail: 'bg-[var(--color-violet)]',
    badge: 'violet',
    label: 'reflect',
  },
  system_event: {
    icon: <Activity className="h-3 w-3" />,
    rail: 'bg-[var(--color-rose)]',
    badge: 'red',
    label: 'system',
  },
};

interface RowDescription {
  title: string;
  detail?: string;
  fips?: number | null;
  taskId?: string;
}

function describe(event: ObserverEvent): RowDescription {
  if (event.kind === 'indicator_received') {
    const p = event.payload as IndicatorPayload;
    const meta = lookupStateByFips(p.state_fips ?? 0);
    return {
      title: `${meta?.abbr ?? '?'} · ${p.indicator?.toUpperCase() ?? 'IND'} ${p.value ?? '—'}`,
      detail: p.source ? `from ${p.source}` : undefined,
      fips: p.state_fips ?? null,
    };
  }
  if (event.kind === 'fed_rate_received') {
    const p = event.payload as FedRatePayload;
    return {
      title: `Federal funds → ${(((p.rate_bps ?? 0) / 100) || 0).toFixed(2)}%`,
      detail: p.rationale,
    };
  }
  if (event.kind === 'peer_update') {
    const p = event.payload as PeerPayload;
    return {
      title: `Mesh topology change → ${p.peer_count ?? 0} peers`,
      detail: p.observer_pubkey
        ? `observer pubkey ${p.observer_pubkey.slice(0, 12)}…`
        : 'AXL peer set rotated',
    };
  }
  if (event.kind === 'inft_manifest_updated') {
    const p = event.payload as { count?: number; mint_status?: string };
    return {
      title: `iNFT manifest refresh → ${p.count ?? 0} entries`,
      detail: p.mint_status ? `status: ${p.mint_status}` : '0G persona snapshot updated',
    };
  }
  if (event.kind === 'negotiation_round') {
    const r = event.payload as NegotiationRound;
    const from = lookupStateByFips(r.from_fips)?.abbr ?? `FIPS${r.from_fips}`;
    const to = r.to_fips != null ? (lookupStateByFips(r.to_fips)?.abbr ?? `FIPS${r.to_fips}`) : '?';
    return {
      title: `${from} → ${to} · ${r.stage} (round ${r.round})`,
      detail: r.summary,
      fips: r.from_fips,
      taskId: r.task_id,
    };
  }
  if (event.kind === 'swap_executed') {
    const s = event.payload as SwapEvent;
    const from = lookupStateByFips(s.from_fips)?.abbr ?? `FIPS${s.from_fips}`;
    const to = lookupStateByFips(s.to_fips)?.abbr ?? `FIPS${s.to_fips}`;
    return {
      title: `${from} ⇄ ${to} swap settled`,
      detail: `tx ${compactHash(s.tx_hash)}`,
      fips: s.from_fips,
    };
  }
  if (event.kind === 'shock_injected') {
    const sh = event.payload as ShockEvent;
    const meta = lookupStateByFips(sh.state_fips);
    return {
      title: `${meta?.abbr ?? `FIPS${sh.state_fips}`} · ${sh.event_type.replaceAll('_', ' ')}`,
      detail: `severity ${sh.severity}/10 from ${sh.source}`,
      fips: sh.state_fips,
    };
  }
  if (event.kind === 'reflection') {
    const r = event.payload as ReflectionEvent;
    const meta = lookupStateByFips(r.state_fips);
    return {
      title: `${meta?.abbr ?? r.state_abbr} reflected`,
      detail: r.summary,
      fips: r.state_fips,
    };
  }
  if (event.kind === 'mesh_snapshot') return { title: 'Mesh snapshot' };
  return { title: event.kind.replaceAll('_', ' ') };
}

interface FeedRow {
  event: ObserverEvent;
  description: RowDescription;
  count: number;
  visuals: EventVisuals;
}

/**
 * Group consecutive same-kind events from the same FIPS into one row with
 * a count badge. Keeps the feed readable when many indicators land in burst.
 */
function compress(events: ObserverEvent[]): FeedRow[] {
  const out: FeedRow[] = [];
  for (const event of events) {
    const visuals = VISUALS[event.kind] ?? VISUALS.system_event;
    const description = describe(event);
    const last = out[out.length - 1];
    const sameFips =
      last && last.event.kind === event.kind && (last.description.fips ?? null) === (description.fips ?? null);
    if (sameFips && last) {
      last.count += 1;
      continue;
    }
    if (!visuals) continue;
    out.push({ event, description, count: 1, visuals });
  }
  return out;
}

export function EventFeed({ events, onSelectFips, onSelectNegotiation }: EventFeedProps) {
  const { allowedEventKinds } = useLayers();
  const filtered = useMemo(
    () => events.filter((e) => allowedEventKinds.has(e.kind)),
    [events, allowedEventKinds],
  );
  const rows = useMemo(() => compress(filtered), [filtered]);

  return (
    <Card className="h-full min-h-0">
      <CardHeader>
        <CardTitle>
          <Activity className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          AXL live feed
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {filtered.length}/{events.length}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-full">
          <ol className="divide-y divide-[var(--color-border)]">
            {rows.length === 0 ? (
              <li className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                No events match the active layers.
              </li>
            ) : (
              rows.map((row, i) => {
                const { event, description, count, visuals } = row;
                const interactive = description.taskId || description.fips != null;
                return (
                  <li
                    key={`${event.id}-${i}`}
                    className={cn(
                      'animate-fade-in-up relative pl-3 pr-2.5 py-1.5 text-[12px]',
                      'before:content-[""] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:rounded-r',
                      `before:${visuals.rail.replace('bg-', 'bg-')}`,
                      interactive ? 'cursor-pointer hover:bg-[var(--color-surface-elevated)]/40' : '',
                    )}
                    style={{ ['--rail-color' as string]: 'currentColor' }}
                    onClick={() => {
                      if (description.taskId) onSelectNegotiation?.(description.taskId);
                      else if (description.fips != null) onSelectFips?.(description.fips);
                    }}
                  >
                    <span
                      className={cn(
                        'absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-r',
                        visuals.rail,
                      )}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0 font-medium text-[var(--color-fg)]">
                        <span
                          className={cn(
                            'inline-flex h-4 w-4 items-center justify-center rounded',
                            visuals.badge === 'cyan' && 'bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]',
                            visuals.badge === 'violet' &&
                              'bg-[var(--color-violet)]/15 text-[var(--color-violet)]',
                            visuals.badge === 'amber' &&
                              'bg-[var(--color-amber)]/15 text-[var(--color-amber)]',
                            visuals.badge === 'emerald' &&
                              'bg-[var(--color-emerald)]/15 text-[var(--color-emerald)]',
                            visuals.badge === 'red' &&
                              'bg-[var(--color-red)]/15 text-[var(--color-red)]',
                            visuals.badge === 'rose' &&
                              'bg-[var(--color-rose)]/15 text-[var(--color-rose)]',
                            visuals.badge === 'muted' &&
                              'bg-[var(--color-bg)] text-[var(--color-fg-subtle)]',
                          )}
                        >
                          {visuals.icon}
                        </span>
                        <span className="truncate">{description.title}</span>
                        {count > 1 && (
                          <span className="shrink-0 rounded bg-[var(--color-bg)] px-1.5 py-px font-mono text-[10px] text-[var(--color-fg-subtle)]">
                            ×{count}
                          </span>
                        )}
                      </span>
                      <time className="font-mono text-[10px] text-[var(--color-fg-subtle)] shrink-0">
                        {formatTime(event.timestamp)}
                      </time>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 pl-5">
                      <span className="truncate text-[11px] text-[var(--color-fg-muted)]">
                        {description.detail ?? event.kind.replaceAll('_', ' ')}
                      </span>
                      <Badge variant={visuals.badge} className="shrink-0">
                        {visuals.label}
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
