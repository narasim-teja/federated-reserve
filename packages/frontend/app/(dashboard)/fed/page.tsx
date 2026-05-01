'use client';

import { Activity, Building2, CloudLightning, Landmark, Sparkles, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useObserverContext } from '@/hooks/use-observer-context';
import { observerApi } from '@/lib/api';
import { formatRatio, formatTime, formatUsd, relativeTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import type { FedRateHistoryEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function FedPage() {
  const { snapshot } = useObserverContext();
  const [history, setHistory] = useState<FedRateHistoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await observerApi.fedRateHistory();
        if (!cancelled) setHistory(res.entries);
      } catch {
        // observer offline → fall back to snapshot
      }
    }
    void refresh();
    const id = setInterval(refresh, 6_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const merged = history.length > 0 ? history : (snapshot?.fed_rate_history ?? []);
  const latest = snapshot?.latest_fed_rate;

  const aggregates = useMemo(() => {
    const states = snapshot?.states ?? [];
    const deep = states.filter((s) => s.tier === 'deep');
    const stressed = states.filter((s) => s.health === 'red');
    const watch = states.filter((s) => s.health === 'amber');
    const avgReserve =
      states.reduce((acc, s) => acc + (s.reserve_ratio ?? 0), 0) /
      Math.max(1, states.filter((s) => s.reserve_ratio != null).length);
    const meshTvl = states.reduce((acc, s) => acc + (s.total_value_usd ?? 0), 0);
    const unemploymentValues = states
      .map((s) => s.latest_indicator?.indicator === 'unemployment' ? s.latest_indicator.value : null)
      .filter((v): v is number => typeof v === 'number');
    const avgUnemployment =
      unemploymentValues.length > 0
        ? unemploymentValues.reduce((a, b) => a + b, 0) / unemploymentValues.length
        : null;
    return {
      deepCount: deep.length,
      stressed: stressed.length,
      watch: watch.length,
      avgReserve: Number.isFinite(avgReserve) ? avgReserve : null,
      meshTvl,
      avgUnemployment,
    };
  }, [snapshot]);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Hero — current rate */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <Landmark className="h-3.5 w-3.5 text-[var(--color-violet)]" />
              Federal Reserve
            </CardTitle>
            {latest ? (
              <Badge variant="violet" className="font-mono">
                effective {formatTime(latest.received_at)}
              </Badge>
            ) : (
              <Badge variant="muted">no rate broadcast yet</Badge>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                  Federal funds rate
                </div>
                <div className="text-5xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
                  {latest ? `${(latest.rate_bps / 100).toFixed(2)}%` : '—'}
                </div>
              </div>
              <RateDelta history={merged} />
            </div>
            {latest?.rationale ? (
              <div>
                <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                  Rationale
                </h3>
                <p className="mt-1 text-[13px] text-[var(--color-fg)]">{latest.rationale}</p>
              </div>
            ) : null}

            <Separator />

            <RateChart history={merged} />
          </CardContent>
        </Card>

        {/* Mesh aggregates */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
              Mesh aggregates
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Stat label="Deep agents" value={`${aggregates.deepCount}`} />
            <Stat label="Mesh TVL" value={formatUsd(aggregates.meshTvl)} />
            <Stat
              label="Avg reserve"
              value={aggregates.avgReserve == null ? '—' : formatRatio(aggregates.avgReserve)}
            />
            <Stat
              label="Avg unemp"
              value={
                aggregates.avgUnemployment == null
                  ? '—'
                  : `${aggregates.avgUnemployment.toFixed(1)}%`
              }
            />
            <Stat
              label="States stressed"
              value={`${aggregates.stressed}`}
              tone={aggregates.stressed > 0 ? 'red' : 'muted'}
            />
            <Stat
              label="States on watch"
              value={`${aggregates.watch}`}
              tone={aggregates.watch > 0 ? 'amber' : 'muted'}
            />
          </CardContent>
        </Card>

        {/* Active shock injections */}
        <Card>
          <CardHeader>
            <CardTitle>
              <CloudLightning className="h-3.5 w-3.5 text-[var(--color-rose)]" />
              Recent shock injections
            </CardTitle>
            <Badge variant="muted" className="font-mono">
              {snapshot?.shocks.length ?? 0}
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[260px]">
              {(snapshot?.shocks ?? []).length === 0 ? (
                <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                  No active NOAA shock injections.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {snapshot?.shocks.map((s, i) => {
                    const meta = lookupStateByFips(s.state_fips);
                    return (
                      <li
                        key={`${s.state_fips}-${i}`}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]"
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant={s.severity >= 7 ? 'red' : s.severity >= 4 ? 'amber' : 'muted'}>
                            sev {s.severity}
                          </Badge>
                          <div>
                            <div className="font-mono text-[11px] font-bold">
                              {meta?.abbr ?? `FIPS${s.state_fips}`}
                            </div>
                            <div className="text-[11px] text-[var(--color-fg-muted)]">
                              {s.event_type.replaceAll('_', ' ')}
                            </div>
                          </div>
                        </div>
                        <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                          {relativeTime(s.emitted_at)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Rate change ledger */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <Activity className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
              Rate decision ledger
            </CardTitle>
            <Badge variant="muted" className="font-mono">
              {merged.length}
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[320px]">
              {merged.length === 0 ? (
                <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
                  Rate broadcasts will appear here as the FED agent ticks.
                </p>
              ) : (
                <ol className="divide-y divide-[var(--color-border)]">
                  {merged
                    .slice()
                    .reverse()
                    .map((entry, i, arr) => {
                      const prev = arr[i + 1];
                      const delta = prev ? entry.rate_bps - prev.rate_bps : 0;
                      return (
                        <li key={entry.id} className="flex items-start gap-3 px-3 py-2">
                          <Badge
                            variant={delta > 0 ? 'amber' : delta < 0 ? 'cyan' : 'muted'}
                            className="shrink-0"
                          >
                            {delta === 0
                              ? `${(entry.rate_bps / 100).toFixed(2)}%`
                              : `${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)}%`}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-mono text-[12px] tabular-nums text-[var(--color-fg)]">
                                {(entry.rate_bps / 100).toFixed(2)}%
                              </span>
                              <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                                {formatTime(entry.received_at)} · {relativeTime(entry.received_at)}
                              </span>
                            </div>
                            <p className="text-[12px] leading-snug text-[var(--color-fg-muted)]">
                              {entry.rationale}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                </ol>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* State health by region */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Building2 className="h-3.5 w-3.5 text-[var(--color-emerald)]" />
              Deep-tier roster
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[320px]">
              <ul className="divide-y divide-[var(--color-border)]">
                {(snapshot?.states ?? [])
                  .filter((s) => s.tier === 'deep')
                  .sort((a, b) => a.abbr.localeCompare(b.abbr))
                  .map((s) => (
                    <li
                      key={s.abbr}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            s.health === 'green'
                              ? 'emerald'
                              : s.health === 'amber'
                                ? 'amber'
                                : s.health === 'red'
                                  ? 'red'
                                  : 'muted'
                          }
                        >
                          {s.abbr}
                        </Badge>
                        <span className="text-[var(--color-fg-muted)]">{s.name}</span>
                      </div>
                      <div className="font-mono text-[11px] text-[var(--color-fg-subtle)]">
                        {formatRatio(s.reserve_ratio)}
                      </div>
                    </li>
                  ))}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RateDelta({ history }: { history: FedRateHistoryEntry[] }) {
  if (history.length < 2) return null;
  const last = history[history.length - 1]!;
  const prev = history[history.length - 2]!;
  const delta = last.rate_bps - prev.rate_bps;
  if (delta === 0) return null;
  const tone = delta > 0 ? 'amber' : 'cyan';
  return (
    <Badge variant={tone} className="font-mono">
      <TrendingUp className={cn('h-3 w-3', delta < 0 && 'rotate-180')} />
      {delta > 0 ? '+' : ''}
      {(delta / 100).toFixed(2)}% vs prev
    </Badge>
  );
}

function RateChart({ history }: { history: FedRateHistoryEntry[] }) {
  if (history.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-fg-subtle)]">
        No rate history yet — chart will populate as the FED agent broadcasts.
      </p>
    );
  }
  const W = 720;
  const H = 120;
  const PAD_X = 16;
  const PAD_Y = 12;

  const bps = history.map((h) => h.rate_bps);
  const min = Math.min(...bps);
  const max = Math.max(...bps);
  const span = Math.max(25, max - min);
  const yMin = Math.max(0, min - 25);
  const yMax = max + 25;
  const xScale = (i: number) =>
    history.length === 1 ? W / 2 : PAD_X + (i / (history.length - 1)) * (W - PAD_X * 2);
  const yScale = (rate: number) =>
    H - PAD_Y - ((rate - yMin) / (yMax - yMin)) * (H - PAD_Y * 2);

  const points = history.map((h, i) => `${xScale(i)},${yScale(h.rate_bps)}`).join(' ');
  const last = history[history.length - 1]!;

  void span;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id="fed-rate-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-violet)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-violet)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline
          fill="url(#fed-rate-fill)"
          stroke="none"
          points={`${PAD_X},${H - PAD_Y} ${points} ${W - PAD_X},${H - PAD_Y}`}
        />
        <polyline
          fill="none"
          stroke="var(--color-violet)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          points={points}
        />
        {history.map((h, i) => (
          <circle
            key={h.id}
            cx={xScale(i)}
            cy={yScale(h.rate_bps)}
            r={2.4}
            fill="var(--color-violet)"
          />
        ))}
        <text
          x={W - PAD_X}
          y={yScale(last.rate_bps) - 6}
          textAnchor="end"
          className="font-mono"
          fill="var(--color-fg)"
          fontSize="10"
        >
          {(last.rate_bps / 100).toFixed(2)}%
        </text>
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-fg-subtle)]">
        <span>{formatTime(history[0]!.received_at)}</span>
        <span>{formatTime(last.received_at)}</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'emerald' | 'amber' | 'red' | 'muted';
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 px-3 py-2.5',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
        {label}
      </div>
      <div
        className={cn(
          'text-base font-semibold tabular-nums',
          tone === 'red' && 'text-[var(--color-red)]',
          tone === 'amber' && 'text-[var(--color-amber)]',
          tone === 'emerald' && 'text-[var(--color-emerald)]',
        )}
      >
        {value}
      </div>
    </div>
  );
}
