'use client';

import { ArrowLeftRight, CheckCircle2, ExternalLink, Handshake, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { useObserverContext } from '@/hooks/use-observer-context';
import { compactHash, formatTime, relativeTime } from '@/lib/format';
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

  return (
    <li className={cn('flex w-full', isPivot ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'flex max-w-[78%] flex-col gap-1.5 rounded-lg border px-3 py-2',
          isPivot
            ? 'rounded-bl-none border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/5'
            : 'rounded-br-none border-[var(--color-violet)]/40 bg-[var(--color-violet)]/5',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn(
              'font-mono text-[10px] font-bold tracking-[0.14em]',
              isPivot ? 'text-[var(--color-cyan)]' : 'text-[var(--color-violet)]',
            )}
          >
            {fromAbbr}
            {to ? <span className="text-[var(--color-fg-subtle)]"> → {to.abbr}</span> : null}
          </span>
          <span className="flex items-center gap-2">
            <Badge variant={stageTone}>{stageLabel}</Badge>
            <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
              round {round.round} · {formatTime(round.emitted_at)}
            </span>
          </span>
        </div>
        <p className="text-[12.5px] leading-snug text-[var(--color-fg)]">{round.summary}</p>
        {round.terms ? <TermsPanel terms={round.terms} /> : null}
      </div>
    </li>
  );
}

function TermsPanel({ terms }: { terms: NonNullable<NegotiationRound['terms']> }) {
  if (!terms) return null;
  const { give, receive, contribution_usd, duration_days, coalition_tag, tx_hash, explorer_url } =
    terms;
  return (
    <div className="mt-1 grid grid-cols-1 gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2 text-[11px] sm:grid-cols-2">
      {give ? <Term label="give" value={`${give.amount} ${give.asset}`} /> : null}
      {receive ? <Term label="receive" value={`${receive.amount} ${receive.asset}`} /> : null}
      {contribution_usd != null ? <Term label="contribution" value={`$${contribution_usd}`} /> : null}
      {duration_days != null ? <Term label="duration" value={`${duration_days}d`} /> : null}
      {coalition_tag ? <Term label="coalition" value={coalition_tag} /> : null}
      {tx_hash ? (
        <Term
          label="settled"
          value={
            <a
              href={explorer_url ?? `https://sepolia.uniscan.xyz/tx/${tx_hash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
            >
              {compactHash(tx_hash)}
              <ExternalLink className="h-3 w-3" />
            </a>
          }
        />
      ) : null}
    </div>
  );
}

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="font-mono text-[11px] text-[var(--color-fg)]">{value}</span>
    </div>
  );
}
