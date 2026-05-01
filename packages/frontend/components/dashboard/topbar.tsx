'use client';

import { Bell, Github, Maximize2, Search, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/status-dot';
import { useUtcClock } from '@/hooks/use-clock';
import { formatNumber } from '@/lib/format';
import type { Snapshot } from '@/lib/types';
import { cn } from '@/lib/utils';

interface TopbarProps {
  snapshot: Snapshot | null;
  connection: 'idle' | 'connecting' | 'live' | 'retrying';
}

const DEFCON_LEVELS = [
  { level: 5, label: 'CALM', tone: 'emerald' as const, threshold: 0 },
  { level: 4, label: 'NORM', tone: 'emerald' as const, threshold: 1 },
  { level: 3, label: 'WATCH', tone: 'amber' as const, threshold: 3 },
  { level: 2, label: 'WARN', tone: 'amber' as const, threshold: 6 },
  { level: 1, label: 'CRIT', tone: 'red' as const, threshold: 10 },
];

function deriveDefcon(snapshot: Snapshot | null): {
  level: number;
  label: string;
  tone: 'emerald' | 'amber' | 'red';
  percent: number;
} {
  const stressed = snapshot?.states.filter((s) => s.health === 'red').length ?? 0;
  let chosen: (typeof DEFCON_LEVELS)[number] = DEFCON_LEVELS[0] as (typeof DEFCON_LEVELS)[number];
  for (const tier of DEFCON_LEVELS) if (stressed >= tier.threshold) chosen = tier;
  const total = snapshot?.states.length ?? 0;
  const ratio = total === 0 ? 0 : stressed / total;
  return {
    level: chosen.level,
    label: chosen.label,
    tone: chosen.tone,
    percent: Math.round(ratio * 100),
  };
}

export function Topbar({ snapshot, connection }: TopbarProps) {
  const clock = useUtcClock();
  const defcon = useMemo(() => deriveDefcon(snapshot), [snapshot]);
  const live = connection === 'live';
  const alerts = snapshot?.states.filter((s) => s.health === 'red' || s.health === 'amber').length ?? 0;

  return (
    <header className="relative z-30 flex h-12 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur-md px-3 font-mono text-[11px] uppercase tracking-[0.12em]">
      <div className="flex items-center gap-2 pr-3 border-r border-[var(--color-border)]">
        <span className="relative flex h-7 w-7 items-center justify-center">
          <span className="absolute inset-0 rounded-md bg-gradient-to-br from-[var(--color-cyan)] via-[var(--color-violet)] to-[var(--color-emerald)] opacity-70 blur-[3px]" />
          <span className="relative flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[10px] font-bold tracking-wider">
            FR
          </span>
        </span>
        <span className="text-[14px] font-bold text-[var(--color-fg)] tracking-[0.32em]">
          RESERVE
        </span>
        <span className="text-[10px] text-[var(--color-fg-subtle)]">v0.5</span>
      </div>

      <a
        href="https://github.com/koala73/worldmonitor"
        target="_blank"
        rel="noreferrer"
        className="hidden md:inline-flex items-center gap-1.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <Github className="h-3.5 w-3.5" />
        <span className="text-[10px]">53k</span>
      </a>

      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-bold text-[10px]',
          live ? 'text-[var(--color-emerald)]' : 'text-[var(--color-amber)]',
        )}
      >
        <StatusDot health={live ? 'green' : 'amber'} pulse={live} size={6} />
        {live ? 'LIVE' : connection.toUpperCase()}
      </span>

      <span className="hidden md:inline text-[10px] text-[var(--color-fg-muted)]">Mesh</span>
      <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)]/50 text-[var(--color-fg)]">
        50 STATES
        <span className="text-[var(--color-fg-subtle)]">▾</span>
      </span>

      <DefconPill level={defcon.level} label={defcon.label} tone={defcon.tone} percent={defcon.percent} />

      <div className="flex-1" />

      <span className="hidden lg:flex items-center gap-3 text-[var(--color-fg-muted)]">
        <span className="text-[var(--color-fg-subtle)]">PEERS</span>
        <span className="text-[var(--color-fg)] tabular-nums">{formatNumber(snapshot?.mesh.peer_count ?? 0)}</span>
        <span className="text-[var(--color-fg-subtle)]">|</span>
        <span className="text-[var(--color-fg-subtle)]">MSG/MIN</span>
        <span className="text-[var(--color-fg)] tabular-nums">{formatNumber(snapshot?.metrics.messages_per_minute ?? 0)}</span>
        <span className="text-[var(--color-fg-subtle)]">|</span>
        <span className="text-[var(--color-fg)] tabular-nums">{clock}</span>
      </span>

      <div className="flex items-center gap-1 pl-2 border-l border-[var(--color-border)]">
        <ToolbarButton icon={<Bell className="h-3.5 w-3.5" />} count={alerts} />
        <ToolbarButton icon={<Search className="h-3.5 w-3.5" />} label="Search" />
        <ToolbarButton icon={<Maximize2 className="h-3.5 w-3.5" />} />
        <ToolbarButton icon={<Settings className="h-3.5 w-3.5" />} />
      </div>

      <Badge variant="emerald" className="hidden sm:inline-flex">Phase 5</Badge>
    </header>
  );
}

function DefconPill({
  level,
  label,
  tone,
  percent,
}: {
  level: number;
  label: string;
  tone: 'emerald' | 'amber' | 'red';
  percent: number;
}) {
  const toneClass = {
    emerald: 'border-[var(--color-emerald)]/60 text-[var(--color-emerald)] bg-[var(--color-emerald)]/10',
    amber: 'border-[var(--color-amber)]/60 text-[var(--color-amber)] bg-[var(--color-amber)]/10',
    red: 'border-[var(--color-red)]/60 text-[var(--color-red)] bg-[var(--color-red)]/10',
  }[tone];
  return (
    <span
      className={cn(
        'hidden md:inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-bold',
        toneClass,
      )}
      title={`Mesh DEFCON ${level} — ${percent}% states stressed`}
    >
      DEFCON {level}
      <span className="opacity-70">{percent}%</span>
      <span className="hidden xl:inline opacity-70">{label}</span>
    </span>
  );
}

function ToolbarButton({
  icon,
  count,
  label,
}: {
  icon: React.ReactNode;
  count?: number;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="relative inline-flex items-center gap-1.5 rounded px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]"
    >
      {icon}
      {label && <span className="hidden lg:inline text-[10px]">{label}</span>}
      {count != null && count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[var(--color-red)] px-1 text-[9px] font-bold text-[var(--color-bg)]">
          {count}
        </span>
      )}
    </button>
  );
}
