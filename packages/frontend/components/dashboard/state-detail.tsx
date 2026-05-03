'use client';

import { Activity, ArrowUpRight, Coins, ExternalLink, Gauge, Sparkles, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { StatusDot } from '@/components/ui/status-dot';
import { compactAddress, formatRatio, formatTime, formatUsd, relativeTime } from '@/lib/format';
import type { Health, StateView } from '@/lib/types';
import { cn } from '@/lib/utils';

interface StateDetailProps {
  state: StateView | null;
}

const HEALTH_LABEL: Record<Health, string> = {
  green: 'Healthy',
  amber: 'Watch',
  red: 'Stress',
  unknown: 'No data',
};

export function StateDetail({ state }: StateDetailProps) {
  if (!state) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle>Focused Agent</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center text-sm text-[var(--color-fg-subtle)]">
          Select a state on the map to drill in.
        </CardContent>
      </Card>
    );
  }

  const tierBadge = state.tier === 'deep' ? 'violet' : state.tier === 'federal' ? 'cyan' : 'muted';

  return (
    <Card className="h-full flex flex-col min-h-0">
      <CardHeader>
        <CardTitle>
          <StatusDot health={state.health} size={9} />
          Focused Agent
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={tierBadge}>{state.tier}</Badge>
          <Badge
            variant={
              state.health === 'green'
                ? 'emerald'
                : state.health === 'amber'
                  ? 'amber'
                  : state.health === 'red'
                    ? 'red'
                    : 'muted'
            }
          >
            {HEALTH_LABEL[state.health]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full">
        <div className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="text-2xl font-semibold leading-tight">{state.name}</h2>
          <p className="text-xs text-[var(--color-fg-muted)] mt-1 font-mono uppercase tracking-[0.14em]">
            {state.abbr} · {state.region} · fips {state.fips}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Stat
            icon={<Gauge className="h-3.5 w-3.5" />}
            label="Reserve ratio"
            value={formatRatio(state.reserve_ratio)}
            tone={
              state.reserve_ratio == null
                ? 'muted'
                : state.reserve_ratio < 0.08
                  ? 'red'
                  : state.reserve_ratio < 0.12
                    ? 'amber'
                    : 'emerald'
            }
          />
          <Stat
            icon={<Coins className="h-3.5 w-3.5" />}
            label="Treasury value"
            value={formatUsd(state.total_value_usd)}
          />
          <Stat
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Tick"
            value={state.tick_count == null ? '—' : `#${state.tick_count}`}
          />
          <Stat
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="Last seen"
            value={relativeTime(state.last_seen_at)}
          />
        </div>

        {state.wallet_address ? (
          <>
            <Separator />
            <section>
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)] mb-2 flex items-center gap-2">
                <Wallet className="h-3 w-3" />
                Onchain
                {state.chain_balances ? (
                  <Badge variant="muted" className="font-mono">
                    block #{state.chain_balances.block_number}
                  </Badge>
                ) : null}
              </h4>
              <div className="flex flex-col gap-1 text-[12px]">
                <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-1.5">
                  <span className="font-mono text-[var(--color-fg-muted)]">wallet</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{compactAddress(state.wallet_address)}</span>
                    {state.chain_balances?.wallet_explorer_url ? (
                      <a
                        href={state.chain_balances.wallet_explorer_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline font-mono text-[10px]"
                      >
                        Unichain
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </span>
                </div>
                {state.chain_balances ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-1.5">
                    <span className="font-mono text-[var(--color-fg-muted)]">USDC</span>
                    <span className="font-mono text-[var(--color-emerald)]">
                      {trimDecimal(state.chain_balances.usdc_balance)}{' '}
                      <span className="text-[var(--color-fg-subtle)]">
                        · {(state.chain_balances.liquid_reserve_ratio * 100).toFixed(1)}%
                      </span>
                    </span>
                  </div>
                ) : null}
                {state.chain_balances?.state_token ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-1.5">
                    <span className="font-mono text-[var(--color-fg-muted)]">
                      {state.chain_balances.state_token.symbol}
                    </span>
                    <span className="font-mono text-[var(--color-cyan)]">
                      {trimDecimal(state.chain_balances.state_token.balance)}
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          </>
        ) : null}

        <Separator />

        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)] mb-2">
            Latest indicator
          </h4>
          {state.latest_indicator ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/70 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">
                  {state.latest_indicator.indicator.toUpperCase()}{' '}
                  <span className="font-mono text-[var(--color-cyan)]">
                    {state.latest_indicator.value}
                  </span>
                </span>
                <Badge variant="muted">{state.latest_indicator.source}</Badge>
              </div>
              <span className="text-[11px] text-[var(--color-fg-subtle)] font-mono">
                {formatTime(state.latest_indicator.received_at)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-fg-subtle)]">No indicator received yet.</p>
          )}
        </section>

        <section>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)] mb-2 flex items-center justify-between">
            <span>Composition</span>
            <span className="font-mono text-[var(--color-fg-subtle)] normal-case tracking-normal">
              {state.composition.length} assets
            </span>
          </h4>
          {state.composition.length === 0 ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">Treasury not yet hydrated.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {state.composition.slice(0, 6).map((row) => (
                <li
                  key={row.asset}
                  className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-1.5 text-sm"
                >
                  <span className="font-mono text-[var(--color-fg)]">{row.asset}</span>
                  <span className="font-mono text-[var(--color-fg-muted)]">{row.balance}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function Stat({
  icon,
  label,
  value,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'default' | 'emerald' | 'amber' | 'red' | 'muted';
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 px-3 py-2.5">
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded mb-1.5',
          tone === 'emerald' && 'bg-[var(--color-emerald)]/15 text-[var(--color-emerald)]',
          tone === 'amber' && 'bg-[var(--color-amber)]/15 text-[var(--color-amber)]',
          tone === 'red' && 'bg-[var(--color-red)]/15 text-[var(--color-red)]',
          tone === 'muted' && 'bg-[var(--color-bg)] text-[var(--color-fg-subtle)]',
          tone === 'default' && 'bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]',
        )}
      >
        {icon}
      </span>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums truncate">{value}</div>
    </div>
  );
}

function trimDecimal(d: string): string {
  if (!d) return '0';
  const dot = d.indexOf('.');
  if (dot === -1) return d;
  return `${d.slice(0, dot)}.${d.slice(dot + 1, dot + 3)}`;
}

export function StateDetailLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-[var(--color-cyan)] hover:underline"
    >
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </a>
  );
}
