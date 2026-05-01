'use client';

import { ExternalLink, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { compactAddress, compactHash } from '@/lib/format';
import type { InftEntry } from '@/lib/types';

interface InftGridProps {
  entries: InftEntry[];
}

export function InftGrid({ entries }: InftGridProps) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>
          <WalletCards className="h-3.5 w-3.5 text-[var(--color-violet)]" />
          iNFT Manifest · 0G
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {entries.length} agents
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-full">
          <ul className="grid grid-cols-1 gap-2 p-3">
            {entries.map((entry) => {
              const minted = entry.mint_status === 'minted';
              return (
                <li
                  key={entry.state_abbr}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-elevated)]/40 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-sm font-bold tracking-wider text-[var(--color-fg)]">
                        {entry.state_abbr}
                      </span>
                      <span className="text-xs text-[var(--color-fg-muted)] truncate">
                        {entry.state_name}
                      </span>
                    </div>
                    <Badge variant={minted ? 'emerald' : 'amber'}>{entry.mint_status}</Badge>
                  </div>
                  <p className="text-[11px] leading-snug text-[var(--color-fg-muted)] line-clamp-2 mb-2">
                    {entry.persona_tagline}
                  </p>
                  <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
                    <dt className="text-[var(--color-fg-subtle)]">owner</dt>
                    <dd className="truncate text-[var(--color-fg)]">
                      {compactAddress(entry.owner_address)}
                    </dd>
                    <dt className="text-[var(--color-fg-subtle)]">hash</dt>
                    <dd className="truncate text-[var(--color-fg)]">
                      {compactHash(entry.metadata_hash)}
                    </dd>
                    <dt className="text-[var(--color-fg-subtle)]">chain</dt>
                    <dd className="truncate text-[var(--color-fg)] flex items-center gap-1.5">
                      {entry.contract.chain}
                      {entry.contract.explorer_url && (
                        <a
                          href={entry.contract.explorer_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--color-cyan)] hover:underline inline-flex"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
