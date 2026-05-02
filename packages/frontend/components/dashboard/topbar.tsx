'use client';

import { Github, Search } from 'lucide-react';
import { Logo } from '@/components/ui/logo';
import { StatusDot } from '@/components/ui/status-dot';
import { useUtcClock } from '@/hooks/use-clock';
import { formatNumber } from '@/lib/format';
import type { Snapshot } from '@/lib/types';
import { cn } from '@/lib/utils';

interface TopbarProps {
  snapshot: Snapshot | null;
  connection: 'idle' | 'connecting' | 'live' | 'retrying';
  onOpenPalette?: () => void;
}

export function Topbar({ snapshot, connection, onOpenPalette }: TopbarProps) {
  const clock = useUtcClock();
  const live = connection === 'live';

  return (
    <header className="relative z-30 flex h-12 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur-md px-3 font-mono text-[11px] uppercase tracking-[0.12em]">
      <div className="flex items-center gap-2 pr-3 border-r border-[var(--color-border)]">
        <Logo className="h-6 w-6 text-[var(--color-fg)]" />
        <span className="text-[14px] font-bold text-[var(--color-fg)] tracking-[0.32em]">
          RESERVE
        </span>
      </div>

      <a
        href="https://github.com/narasim-teja/federated-reserve"
        target="_blank"
        rel="noreferrer"
        aria-label="GitHub repository"
        className="hidden md:inline-flex items-center gap-1.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <Github className="h-3.5 w-3.5" />
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

      <button
        type="button"
        onClick={onOpenPalette}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden lg:inline text-[10px]">Jump</span>
        <span className="hidden lg:inline rounded border border-[var(--color-border)] px-1 py-px text-[9px] tracking-[0.08em] text-[var(--color-fg-subtle)]">
          ⌘K
        </span>
      </button>
    </header>
  );
}
