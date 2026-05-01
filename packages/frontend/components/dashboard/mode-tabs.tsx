'use client';

import { Activity, Building2, Landmark, MessagesSquare, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { useObserverContext } from '@/hooks/use-observer-context';
import { cn } from '@/lib/utils';

interface ModeTab {
  href: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  match: (pathname: string) => boolean;
  countKey?: 'negotiations' | 'shocks';
}

const TABS: ModeTab[] = [
  {
    href: '/',
    label: 'Live mesh',
    hint: 'Realtime activity across the federation',
    icon: <Activity className="h-3.5 w-3.5" />,
    match: (p) => p === '/',
  },
  {
    href: '/agent/MA',
    label: 'Agent dossier',
    hint: 'Drill into a single state treasurer',
    icon: <Building2 className="h-3.5 w-3.5" />,
    match: (p) => p.startsWith('/agent'),
  },
  {
    href: '/negotiations',
    label: 'Negotiations',
    hint: 'Multi-turn A2A swap & coalition threads',
    icon: <MessagesSquare className="h-3.5 w-3.5" />,
    match: (p) => p.startsWith('/negotiations'),
    countKey: 'negotiations',
  },
  {
    href: '/fed',
    label: 'Federal Reserve',
    hint: 'Federal funds rate and mesh aggregates',
    icon: <Landmark className="h-3.5 w-3.5" />,
    match: (p) => p.startsWith('/fed'),
  },
  {
    href: '/reality',
    label: 'Compare to reality',
    hint: 'Agent decisions vs historical policymaker actions',
    icon: <ScrollText className="h-3.5 w-3.5" />,
    match: (p) => p.startsWith('/reality'),
  },
];

export function ModeTabs() {
  const pathname = usePathname() ?? '/';
  const { snapshot } = useObserverContext();
  const counts = useMemo(
    () => ({
      negotiations: snapshot?.metrics.negotiations_open ?? 0,
      shocks: snapshot?.metrics.shocks_active ?? 0,
    }),
    [snapshot],
  );

  return (
    <nav
      role="tablist"
      aria-label="Dashboard modes"
      className="relative z-20 flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 px-3 backdrop-blur"
    >
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const count = tab.countKey ? counts[tab.countKey] : 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            title={tab.hint}
            className={cn(
              'group relative inline-flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
              active
                ? 'text-[var(--color-fg)]'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            <span
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded',
                active
                  ? 'bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]'
                  : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg)]',
              )}
            >
              {tab.icon}
            </span>
            <span>{tab.label}</span>
            {tab.countKey && count > 0 ? (
              <Badge variant={tab.countKey === 'negotiations' ? 'cyan' : 'rose'} className="ml-1">
                {count}
              </Badge>
            ) : null}
            {active ? (
              <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-[var(--color-cyan)] via-[var(--color-violet)] to-[var(--color-emerald)]" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
