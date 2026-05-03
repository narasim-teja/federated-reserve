'use client';

import { ArrowLeftRight, ArrowRight, CheckCircle2, ExternalLink, Handshake, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { useObserverContext } from '@/hooks/use-observer-context';
import { compactHash, formatTime, formatTokenAmount, relativeTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import type { NegotiationRound, NegotiationStage, NegotiationView } from '@/lib/types';
import { cn } from '@/lib/utils';

interface NegotiationModalProps {
  taskId: string | null;
  onClose: () => void;
}

const STAGE_LABEL: Record<NegotiationStage, string> = {
  proposal: 'Proposal',
  counter: 'Counter',
  accept: 'Accepted',
  reject: 'Rejected',
  settlement: 'Settled',
  coalition_join: 'Joined coalition',
  coalition_decline: 'Declined coalition',
  coalition_counter: 'Counter terms',
};

const STAGE_TONE: Record<NegotiationStage, 'cyan' | 'violet' | 'emerald' | 'red' | 'amber'> = {
  proposal: 'cyan',
  counter: 'amber',
  accept: 'emerald',
  reject: 'red',
  settlement: 'emerald',
  coalition_join: 'emerald',
  coalition_decline: 'red',
  coalition_counter: 'amber',
};

export function NegotiationModal({ taskId, onClose }: NegotiationModalProps) {
  const { snapshot } = useObserverContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const view = useMemo<NegotiationView | null>(() => {
    if (!taskId) return null;
    return snapshot?.negotiations.find((n) => n.task_id === taskId) ?? null;
  }, [snapshot, taskId]);

  useEffect(() => {
    if (!taskId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, onClose]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [view?.rounds.length]);

  if (!taskId) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--color-bg)]/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]">
              <Handshake className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
                A2A · {view?.skill ?? 'unknown skill'}
              </div>
              <div className="truncate font-mono text-[10px] text-[var(--color-fg-subtle)]">
                task {taskId}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {view ? <StatusBadge status={view.status} /> : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              aria-label="close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Participants strip */}
        {view && view.participants.length > 0 && (
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-[11px]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              parties
            </span>
            {view.participants.map((fips, i) => {
              const meta = lookupStateByFips(fips);
              return (
                <span
                  key={fips}
                  className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)]/50 px-1.5 py-0.5"
                >
                  <span className="font-mono text-[10px] font-bold text-[var(--color-fg)]">
                    {meta?.abbr ?? `FIPS${fips}`}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                    {meta?.name ?? ''}
                  </span>
                  {i === 0 ? <ArrowLeftRight className="h-3 w-3 text-[var(--color-fg-subtle)]" /> : null}
                </span>
              );
            })}
            <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-subtle)]">
              opened {relativeTime(view.started_at)}
            </span>
          </div>
        )}

        {/* Thread body */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-bg)]/60 px-4 py-4">
          {!view ? (
            <div className="flex h-full items-center justify-center text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                Loading negotiation…
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-3">
              {view.rounds.map((round, i) => (
                <RoundBubble
                  key={`${round.task_id}-${i}-${round.emitted_at}`}
                  round={round}
                  pivotFips={view.participants[0] ?? round.from_fips}
                />
              ))}
              <div ref={bottomRef} />
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: NegotiationView['status'] }) {
  if (status === 'open') return <Badge variant="cyan">live</Badge>;
  if (status === 'settled')
    return (
      <Badge variant="emerald">
        <CheckCircle2 className="h-3 w-3" /> settled
      </Badge>
    );
  if (status === 'rejected')
    return (
      <Badge variant="red">
        <XCircle className="h-3 w-3" /> rejected
      </Badge>
    );
  return <Badge variant="muted">{status}</Badge>;
}

function RoundBubble({ round, pivotFips }: { round: NegotiationRound; pivotFips: number }) {
  const from = lookupStateByFips(round.from_fips);
  const to = round.to_fips != null ? lookupStateByFips(round.to_fips) : null;
  const fromAbbr = from?.abbr ?? `FIPS${round.from_fips}`;
  const isPivot = round.from_fips === pivotFips;
  const stageLabel = STAGE_LABEL[round.stage];
  const stageTone = STAGE_TONE[round.stage];
  const isSettlement = round.stage === 'settlement';

  const accent = isPivot
    ? { text: 'text-[var(--color-cyan)]', border: 'border-[var(--color-cyan)]/40', bg: 'bg-[var(--color-cyan)]/5', ring: 'ring-[var(--color-cyan)]/30', avatarBg: 'bg-[var(--color-cyan)]/15' }
    : { text: 'text-[var(--color-violet)]', border: 'border-[var(--color-violet)]/40', bg: 'bg-[var(--color-violet)]/5', ring: 'ring-[var(--color-violet)]/30', avatarBg: 'bg-[var(--color-violet)]/15' };

  return (
    <li className={cn('flex w-full items-end gap-2', isPivot ? 'justify-start' : 'flex-row-reverse justify-start')}>
      <Avatar abbr={fromAbbr} accent={accent} />
      <div
        className={cn(
          'flex max-w-[78%] flex-col gap-2 rounded-2xl border px-3.5 py-2.5',
          accent.border,
          accent.bg,
          isPivot ? 'rounded-bl-sm' : 'rounded-br-sm',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className={cn('font-mono text-[10px] font-bold tracking-[0.14em]', accent.text)}>
            {fromAbbr}
            {to ? <span className="text-[var(--color-fg-subtle)]"> → {to.abbr}</span> : null}
          </span>
          <span className="flex items-center gap-2">
            <Badge variant={stageTone}>{stageLabel}</Badge>
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
              r{round.round} · {formatTime(round.emitted_at)}
            </span>
          </span>
        </div>
        <p className="text-[12.5px] leading-snug text-[var(--color-fg)]">{round.summary}</p>
        {round.terms ? (
          <TermsPanel terms={round.terms} stage={round.stage} accent={accent} settlement={isSettlement} />
        ) : null}
      </div>
    </li>
  );
}

function Avatar({ abbr, accent }: { abbr: string; accent: { text: string; avatarBg: string; ring: string } }) {
  return (
    <div
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold tracking-tight ring-1',
        accent.avatarBg,
        accent.text,
        accent.ring,
      )}
      title={abbr}
    >
      {abbr.slice(0, 2)}
    </div>
  );
}

function TermsPanel({
  terms,
  accent,
  settlement,
}: {
  terms: NonNullable<NegotiationRound['terms']>;
  stage: NegotiationStage;
  accent: { border: string; bg: string };
  settlement: boolean;
}) {
  if (!terms) return null;
  const { give, receive, contribution_usd, duration_days, coalition_tag, tx_hash, explorer_url } =
    terms;
  const hasSwap = give || receive;
  const meta: { label: string; value: React.ReactNode }[] = [];
  if (contribution_usd != null) meta.push({ label: 'contribution', value: `$${contribution_usd.toLocaleString()}` });
  if (duration_days != null) meta.push({ label: 'duration', value: `${duration_days}d` });
  if (coalition_tag) meta.push({ label: 'coalition', value: coalition_tag });

  return (
    <div className="flex flex-col gap-2">
      {hasSwap ? (
        <div
          className={cn(
            'flex items-stretch gap-2 rounded-lg border bg-[var(--color-bg)]/50 p-2',
            settlement ? 'border-[var(--color-emerald)]/35' : 'border-[var(--color-border)]',
          )}
        >
          <SwapLeg label="give" leg={give} align="left" />
          <div className="flex items-center justify-center px-1 text-[var(--color-fg-subtle)]">
            <ArrowRight className="h-3.5 w-3.5" />
          </div>
          <SwapLeg label="receive" leg={receive} align="right" />
        </div>
      ) : null}
      {meta.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px]">
          {meta.map((m) => (
            <Term key={m.label} label={m.label} value={m.value} />
          ))}
        </div>
      ) : null}
      {tx_hash ? (
        <a
          href={explorer_url ?? `https://sepolia.uniscan.xyz/tx/${tx_hash}`}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center justify-between gap-2 rounded-md border border-[var(--color-emerald)]/40 bg-[var(--color-emerald)]/10 px-2.5 py-1.5 text-[11px] hover:bg-[var(--color-emerald)]/15"
        >
          <span className="flex items-center gap-1.5 text-[var(--color-emerald)]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="font-mono uppercase tracking-[0.14em]">settled on Unichain</span>
          </span>
          <span className="flex items-center gap-1 font-mono text-[10px] text-[var(--color-fg-muted)] group-hover:text-[var(--color-fg)]">
            {compactHash(tx_hash)}
            <ExternalLink className="h-3 w-3" />
          </span>
        </a>
      ) : null}
    </div>
  );
}

function SwapLeg({
  label,
  leg,
  align,
}: {
  label: 'give' | 'receive';
  leg: { amount: string; asset: string } | undefined;
  align: 'left' | 'right';
}) {
  if (!leg) return <div className="flex-1" />;
  return (
    <div className={cn('flex flex-1 flex-col gap-0.5', align === 'right' && 'items-end text-right')}>
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="font-mono text-[14px] font-semibold tabular-nums text-[var(--color-fg)] leading-none">
        {formatTokenAmount(leg.amount, leg.asset)}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
        {leg.asset}
      </span>
    </div>
  );
}

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="font-mono text-[11px] text-[var(--color-fg)]">{value}</span>
    </div>
  );
}
