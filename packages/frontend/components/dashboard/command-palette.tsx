'use client';

import { Building2, Landmark, MessagesSquare, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useObserverContext } from '@/hooks/use-observer-context';
import { cn } from '@/lib/utils';

interface PaletteItem {
  id: string;
  group: 'Modes' | 'States' | 'Negotiations';
  label: string;
  hint?: string;
  href: string;
  icon: React.ReactNode;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const { snapshot } = useObserverContext();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const modes: PaletteItem[] = [
      {
        id: 'mode-live',
        group: 'Modes',
        label: 'Live mesh',
        hint: 'Realtime activity',
        href: '/',
        icon: <Search className="h-3.5 w-3.5" />,
      },
      {
        id: 'mode-fed',
        group: 'Modes',
        label: 'Federal Reserve',
        hint: 'Rate history & aggregates',
        href: '/fed',
        icon: <Landmark className="h-3.5 w-3.5" />,
      },
      {
        id: 'mode-negotiations',
        group: 'Modes',
        label: 'Negotiations',
        hint: 'A2A multi-turn threads',
        href: '/negotiations',
        icon: <MessagesSquare className="h-3.5 w-3.5" />,
      },
    ];
    const states: PaletteItem[] = (snapshot?.states ?? []).map((s) => ({
      id: `state-${s.abbr}`,
      group: 'States',
      label: `${s.name} · ${s.abbr}`,
      hint: `${s.tier} agent · ${s.health}`,
      href: `/agent/${s.abbr}`,
      icon: <Building2 className="h-3.5 w-3.5" />,
    }));
    const negs: PaletteItem[] = (snapshot?.negotiations ?? []).slice(0, 6).map((n) => ({
      id: `neg-${n.task_id}`,
      group: 'Negotiations',
      label: `${n.skill} · ${n.task_id.slice(0, 8)}`,
      hint: `${n.participants.length} parties · ${n.status}`,
      href: `/negotiations?task=${n.task_id}`,
      icon: <MessagesSquare className="h-3.5 w-3.5" />,
    }));
    return [...modes, ...states, ...negs];
  }, [snapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.hint?.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setQuery('');
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === 'Escape') onOpenChange(false);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, filtered.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter') {
        const target = filtered[active];
        if (target) {
          router.push(target.href);
          onOpenChange(false);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, filtered, onOpenChange, open, router]);

  if (!open) return null;

  let lastGroup: string | null = null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-bg)]/70 backdrop-blur-sm pt-[10vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <Search className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to state, mode, or negotiation…"
            className="flex-1 bg-transparent font-mono text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
          />
          <span className="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-[10px] text-[var(--color-fg-subtle)]">
            esc
          </span>
        </div>
        <ul className="max-h-[55vh] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
              no matches
            </li>
          ) : (
            filtered.map((it, i) => {
              const newGroup = it.group !== lastGroup;
              lastGroup = it.group;
              const isActive = i === active;
              return (
                <li key={it.id}>
                  {newGroup && (
                    <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                      {it.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      router.push(it.href);
                      onOpenChange(false);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded px-3 py-2 text-left',
                      isActive
                        ? 'bg-[var(--color-cyan)]/10 text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-elevated)]/40',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded',
                        isActive
                          ? 'bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]'
                          : 'text-[var(--color-fg-subtle)]',
                      )}
                    >
                      {it.icon}
                    </span>
                    <div className="flex flex-1 items-center justify-between gap-3 min-w-0">
                      <span className="truncate font-medium">{it.label}</span>
                      {it.hint && (
                        <span className="truncate font-mono text-[10px] text-[var(--color-fg-subtle)]">
                          {it.hint}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
