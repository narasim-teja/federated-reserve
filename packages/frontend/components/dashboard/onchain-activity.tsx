'use client';

/**
 * Onchain activity tab — recent on-chain settlements (swaps + bond mints +
 * autonomous rebalances) with one-click explorer links. Reads off the
 * observer snapshot (`snapshot.swaps`); the feed updates in real time via
 * the existing WebSocket subscription.
 */

import { ArrowLeftRight, ExternalLink, Layers } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { compactAddress, compactHash, relativeTime } from '@/lib/format';
import { lookupStateByFips } from '@/lib/states';
import type { SwapEvent } from '@/lib/types';

const UNICHAIN_EXPLORER = (
  process.env.NEXT_PUBLIC_UNICHAIN_EXPLORER_BASE_URL ?? 'https://sepolia.uniscan.xyz'
).replace(/\/$/, '');

interface OnchainActivityProps {
  swaps: SwapEvent[];
  onSelectFips?: (fips: number) => void;
}

export function OnchainActivity({ swaps, onSelectFips }: OnchainActivityProps) {
  const sorted = [...swaps].sort((a, b) => b.emitted_at.localeCompare(a.emitted_at));
  const recent = sorted.slice(0, 12);
  const recentCount = recent.length;
  const lastTs = recent[0]?.emitted_at ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Layers className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          Onchain activity
        </CardTitle>
        <Badge variant="muted" className="font-mono">
          {recentCount} recent
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        {lastTs ? (
          <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
            last settlement {relativeTime(lastTs)}
          </div>
        ) : null}
        <ScrollArea className="max-h-[360px]">
          {recent.length === 0 ? (
            <p className="p-4 text-[12px] text-[var(--color-fg-subtle)]">
              No onchain settlements yet. Negotiations and autonomous rebalances will appear here as
              they confirm.
            </p>
          ) : (
            <ol className="divide-y divide-[var(--color-border)]">
              {recent.map((s, i) => (
                <ActivityRow
                  key={`${s.tx_hash}-${i}`}
                  swap={s}
                  onSelectFips={onSelectFips}
                />
              ))}
            </ol>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  swap,
  onSelectFips,
}: {
  swap: SwapEvent;
  onSelectFips?: (fips: number) => void;
}) {
  const fromMeta = lookupStateByFips(swap.from_fips);
  const toMeta = lookupStateByFips(swap.to_fips);
  const fromAbbr = fromMeta?.abbr ?? `FIPS${swap.from_fips}`;
  const toAbbr = toMeta?.abbr ?? `FIPS${swap.to_fips}`;
  const isAutoRebalance = swap.from_fips === swap.to_fips;
  const explorerHref = swap.explorer_url ?? `${UNICHAIN_EXPLORER}/tx/${swap.tx_hash}`;

  return (
    <li className="px-3 py-2 hover:bg-[var(--color-surface-elevated)]/30">
      <div className="flex items-start gap-2">
        <Badge variant={isAutoRebalance ? 'violet' : 'cyan'} className="shrink-0 font-mono">
          <ArrowLeftRight className="mr-1 h-3 w-3" />
          {isAutoRebalance ? 'auto-rebal' : 'swap'}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onSelectFips?.(swap.from_fips)}
              className="font-mono text-[11px] text-[var(--color-fg)] hover:text-[var(--color-cyan)]"
            >
              {fromAbbr}
              {!isAutoRebalance ? (
                <>
                  {' → '}
                  <span
                    className="hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectFips?.(swap.to_fips);
                    }}
                  >
                    {toAbbr}
                  </span>
                </>
              ) : null}
            </button>
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-cyan)] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {compactHash(swap.tx_hash)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
            {prettyAmount(swap.give.amount, swap.give.asset)} → {prettyAmount(swap.receive.amount, swap.receive.asset)}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-[var(--color-fg-subtle)]">
            {compactAddress(fromMeta?.abbr ? fromAbbr : swap.from_fips.toString())} ·{' '}
            {relativeTime(swap.emitted_at)}
          </p>
        </div>
      </div>
    </li>
  );
}

function prettyAmount(raw: string, asset: string): string {
  if (!raw) return `0 ${asset}`;
  // USDC is 6 decimals, state tokens are 18, bonds are 6. Render compactly.
  const decimals = asset === 'USDC' || /B30$/.test(asset) ? 6 : 18;
  try {
    const big = BigInt(raw);
    const div = 10n ** BigInt(decimals);
    const whole = big / div;
    const frac = big % div;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4);
    return `${whole.toString()}${frac > 0n ? `.${fracStr}` : ''} ${asset}`;
  } catch {
    return `${raw} ${asset}`;
  }
}
