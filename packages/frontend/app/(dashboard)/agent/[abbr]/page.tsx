'use client';

import {
  Activity,
  ArrowUpRight,
  Brain,
  Coins,
  ExternalLink,
  Gauge,
  Handshake,
  Landmark,
  ScrollText,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { NegotiationModal } from '@/components/dashboard/negotiation-modal';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { StatusDot } from '@/components/ui/status-dot';
import { useAgentDossier } from '@/hooks/use-agent-dossier';
import { compactAddress, compactHash, formatRatio, formatTime, formatUsd, relativeTime } from '@/lib/format';
import { ALL_STATES, lookupStateByAbbr } from '@/lib/states';
import type { AgentLogEntry, NegotiationView } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function AgentDossierPage() {
  const params = useParams<{ abbr: string }>();
  const abbr = (params?.abbr ?? '').toUpperCase();
  const router = useRouter();
  const meta = lookupStateByAbbr(abbr);
  const { data, log, loading, error } = useAgentDossier(abbr);
  const [activeNegotiation, setActiveNegotiation] = useState<string | null>(null);

  if (!meta) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
            Unknown state: {abbr}
          </p>
          <Link
            href="/agent/MA"
            className="mt-2 inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
          >
            Open Massachusetts <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    );
  }

  const persona = data?.persona;
  const live = data?.live;
  const credit = data?.credit;
  const inft = data?.inft;
  const tier = meta.tier;
  const health = live?.health ?? 'unknown';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Sub-nav: agent picker */}
      <AgentPicker
        currentAbbr={abbr}
        onPick={(next) => router.push(`/agent/${next}`)}
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* Left column — primary identity + activity */}
          <div className="flex flex-col gap-4 min-w-0">
            <Card>
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <StatusDot health={health} size={9} />
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                        {tier} agent · {meta.region}
                      </span>
                    </div>
                    <h1 className="mt-1 text-3xl font-semibold leading-tight">
                      {meta.name} <span className="text-[var(--color-fg-subtle)]">·</span>{' '}
                      <span className="font-mono text-[var(--color-cyan)]">{meta.abbr}</span>
                    </h1>
                    <p className="mt-1 max-w-2xl text-[13px] text-[var(--color-fg-muted)]">
                      {persona?.tagline ?? 'Persona hydrating from observer…'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {credit ? (
                      <Badge variant={creditTone(credit.rating)} className="font-mono">
                        {credit.rating}
                      </Badge>
                    ) : null}
                    {inft ? (
                      <Badge variant={inft.mint_status === 'minted' ? 'emerald' : 'amber'}>
                        iNFT {inft.mint_status}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat
                    icon={<Gauge className="h-3.5 w-3.5" />}
                    label="Reserve ratio"
                    value={formatRatio(live?.reserve_ratio ?? null)}
                  />
                  <Stat
                    icon={<Coins className="h-3.5 w-3.5" />}
                    label="Treasury"
                    value={formatUsd(live?.total_value_usd ?? null)}
                  />
                  <Stat
                    icon={<Activity className="h-3.5 w-3.5" />}
                    label="Tick"
                    value={live?.tick_count == null ? '—' : `#${live.tick_count}`}
                  />
                  <Stat
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    label="Last seen"
                    value={relativeTime(live?.last_seen_at ?? null)}
                  />
                </div>

                {persona?.posture ? (
                  <>
                    <Separator />
                    <div>
                      <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                        Policy posture
                      </h3>
                      <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">
                        {persona.posture}
                      </p>
                    </div>
                  </>
                ) : null}

                {persona?.coalitions && persona.coalitions.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                      coalitions
                    </span>
                    {persona.coalitions.map((c) => (
                      <Badge key={c} variant="violet">
                        {c}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <Brain className="h-3.5 w-3.5 text-[var(--color-violet)]" />
                  Latest reflection
                </CardTitle>
                {data?.latest_reflection ? (
                  <Badge variant="muted" className="font-mono">
                    tick #{data.latest_reflection.tick ?? '—'} ·{' '}
                    {relativeTime(data.latest_reflection.emitted_at)}
                  </Badge>
                ) : null}
              </CardHeader>
              <CardContent>
                {data?.latest_reflection ? (
                  <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">
                    {data.latest_reflection.summary}
                  </p>
                ) : (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    No reflection on record yet — the agent will surface its first reasoning trace
                    after the next reflection tick.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <ScrollText className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
                  Decision timeline
                </CardTitle>
                <Badge variant="muted" className="font-mono">
                  {log.length} entries
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="max-h-[420px]">
                  {loading ? (
                    <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">Loading…</p>
                  ) : error ? (
                    <p className="p-4 text-[12px] text-[var(--color-red)]">Failed: {error}</p>
                  ) : log.length === 0 ? (
                    <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                      No decisions on record yet.
                    </p>
                  ) : (
                    <ol className="divide-y divide-[var(--color-border)]">
                      {log.slice(0, 80).map((entry, i) => (
                        <DecisionRow key={`${entry.at}-${i}`} entry={entry} />
                      ))}
                    </ol>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Right column — sidebars */}
          <div className="flex flex-col gap-4 min-w-0">
            {/* Treasury composition */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <Coins className="h-3.5 w-3.5 text-[var(--color-emerald)]" />
                  Treasury composition
                </CardTitle>
                <Badge variant="muted" className="font-mono">
                  {data?.memory?.composition?.length ?? 0} assets
                </Badge>
              </CardHeader>
              <CardContent>
                {data?.memory?.composition && data.memory.composition.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {data.memory.composition.map((row) => (
                      <li
                        key={row.asset}
                        className="flex items-center justify-between rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-2 text-sm"
                      >
                        <span className="font-mono text-[var(--color-fg)]">{row.asset}</span>
                        <span className="font-mono text-[var(--color-fg-muted)]">
                          {row.balance}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Treasury not yet hydrated.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Credit assessment */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <Landmark className="h-3.5 w-3.5 text-[var(--color-violet)]" />
                  Credit assessment
                </CardTitle>
                {credit ? (
                  <Badge variant={creditTone(credit.rating)} className="font-mono">
                    {credit.rating}
                  </Badge>
                ) : null}
              </CardHeader>
              <CardContent>
                {credit ? (
                  <div className="flex flex-col gap-2 text-[12px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--color-fg-muted)]">Score</span>
                      <span className="font-mono">{credit.score.toFixed(1)} / 100</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--color-fg-muted)]">Yield floor</span>
                      <span className="font-mono">{credit.yieldFloorBps} bps</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--color-fg-muted)]">Yield ceiling</span>
                      <span className="font-mono">{credit.yieldCeilingBps} bps</span>
                    </div>
                    <p className="text-[11px] leading-snug text-[var(--color-fg-muted)]">
                      {credit.summary}
                    </p>
                  </div>
                ) : (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Awaiting reserve ratio + indicators…
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Negotiations list */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <Handshake className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
                  Recent negotiations
                </CardTitle>
                <Badge variant="muted" className="font-mono">
                  {data?.negotiations.length ?? 0}
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                {data?.negotiations.length === 0 ? (
                  <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                    No active or recent negotiations.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {data?.negotiations.slice(0, 8).map((n) => (
                      <NegotiationRow
                        key={n.task_id}
                        view={n}
                        onOpen={() => setActiveNegotiation(n.task_id)}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* iNFT */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <WalletCards className="h-3.5 w-3.5 text-[var(--color-violet)]" />
                  iNFT
                </CardTitle>
                {inft ? (
                  <Badge variant={inft.mint_status === 'minted' ? 'emerald' : 'amber'}>
                    {inft.mint_status}
                  </Badge>
                ) : null}
              </CardHeader>
              <CardContent>
                {inft ? (
                  <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px]">
                    <dt className="text-[var(--color-fg-subtle)]">owner</dt>
                    <dd className="truncate text-[var(--color-fg)]">
                      {compactAddress(inft.owner_address)}
                    </dd>
                    <dt className="text-[var(--color-fg-subtle)]">hash</dt>
                    <dd className="truncate text-[var(--color-fg)]">
                      {compactHash(inft.metadata_hash)}
                    </dd>
                    <dt className="text-[var(--color-fg-subtle)]">chain</dt>
                    <dd className="truncate text-[var(--color-fg)]">{inft.contract.chain}</dd>
                    <dt className="text-[var(--color-fg-subtle)]">contract</dt>
                    <dd className="truncate">
                      {inft.contract.explorer_url ? (
                        <a
                          href={inft.contract.explorer_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                        >
                          {compactAddress(inft.contract.address)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-[var(--color-fg)]">
                          {compactAddress(inft.contract.address)}
                        </span>
                      )}
                    </dd>
                  </dl>
                ) : (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Manifest entry pending.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <NegotiationModal
        taskId={activeNegotiation}
        onClose={() => setActiveNegotiation(null)}
      />
    </div>
  );
}

function AgentPicker({
  currentAbbr,
  onPick,
}: {
  currentAbbr: string;
  onPick: (abbr: string) => void;
}) {
  const sorted = useMemo(() => [...ALL_STATES].sort((a, b) => a.name.localeCompare(b.name)), []);
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 px-3 py-2 backdrop-blur">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
        Agent
      </span>
      <div className="flex flex-1 overflow-x-auto gap-1">
        {sorted
          .filter((s) => s.tier === 'deep')
          .map((s) => (
            <button
              key={s.abbr}
              type="button"
              onClick={() => onPick(s.abbr)}
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px]',
                s.abbr === currentAbbr
                  ? 'border-[var(--color-cyan)] bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]'
                  : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              <span className="font-bold">{s.abbr}</span>
              <span className="text-[var(--color-fg-subtle)]">{s.name}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 px-3 py-2.5">
      <span className="mb-1 inline-flex h-6 w-6 items-center justify-center rounded bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]">
        {icon}
      </span>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums truncate">{value}</div>
    </div>
  );
}

const KIND_TONE: Record<string, 'cyan' | 'violet' | 'emerald' | 'amber' | 'red' | 'muted'> = {
  decision: 'cyan',
  reflection: 'violet',
  broadcast_sent: 'amber',
  broadcast_received: 'cyan',
  negotiation_round: 'emerald',
};

function DecisionRow({ entry }: { entry: AgentLogEntry }) {
  const tone = KIND_TONE[entry.kind] ?? 'muted';
  return (
    <li className="flex items-start gap-3 px-3 py-2 hover:bg-[var(--color-surface-elevated)]/30">
      <Badge variant={tone} className="shrink-0">
        {entry.kind.replaceAll('_', ' ')}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-snug text-[var(--color-fg)]">{entry.summary}</p>
        <p className="mt-0.5 font-mono text-[10px] text-[var(--color-fg-subtle)]">
          {formatTime(entry.at)} · {relativeTime(entry.at)}
        </p>
      </div>
    </li>
  );
}

function NegotiationRow({ view, onOpen }: { view: NegotiationView; onOpen: () => void }) {
  const last = view.rounds[view.rounds.length - 1];
  const tone =
    view.status === 'settled' ? 'emerald' : view.status === 'rejected' ? 'red' : 'cyan';
  return (
    <li className="px-3 py-2 hover:bg-[var(--color-surface-elevated)]/30">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            {view.skill}
          </span>
          <Badge variant={tone}>{view.status}</Badge>
        </div>
        <p className="mt-0.5 truncate text-[12px] text-[var(--color-fg)]">
          {last?.summary ?? 'awaiting next round'}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-[var(--color-fg-subtle)]">
          {view.rounds.length} rounds · {relativeTime(view.last_at)}
        </p>
      </button>
    </li>
  );
}

function creditTone(rating: string): 'emerald' | 'cyan' | 'amber' | 'red' | 'muted' {
  if (rating.startsWith('AAA') || rating.startsWith('AA')) return 'emerald';
  if (rating.startsWith('A')) return 'cyan';
  if (rating.startsWith('BBB') || rating.startsWith('BB')) return 'amber';
  if (rating === 'C' || rating === 'D' || rating.startsWith('B')) return 'red';
  return 'muted';
}
