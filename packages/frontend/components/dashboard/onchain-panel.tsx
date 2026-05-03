'use client';

/**
 * Onchain panel — surfaces real Unichain Sepolia + 0G Galileo state for the
 * focused agent. Reads come from the observer dossier (`data.live.chain_balances`,
 * `data.live.og_status`); writes happen agent-side via the autonomous
 * rebalance policy + Trading API and surface here as the next read tick.
 */

import { CheckCircle2, ExternalLink, Wallet, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { compactAddress, compactHash, relativeTime } from '@/lib/format';
import type { OgStatusView, OnchainBalanceView } from '@/lib/types';

interface OnchainPanelProps {
  walletAddress?: string | null;
  chainBalances?: OnchainBalanceView | null;
  ogStatus?: OgStatusView | null;
}

export function OnchainPanel({ walletAddress, chainBalances, ogStatus }: OnchainPanelProps) {
  const noData = !walletAddress && !chainBalances && !ogStatus;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Wallet className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          Onchain wallet & balances
        </CardTitle>
        {chainBalances ? (
          <Badge variant="muted" className="font-mono">
            block #{chainBalances.block_number} · {relativeTime(chainBalances.fetched_at)}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {noData ? (
          <p className="text-[12px] text-[var(--color-fg-subtle)]">
            No onchain reads yet. The agent will refresh balances on the next tick.
          </p>
        ) : null}

        {walletAddress ? (
          <Row label="Wallet">
            <span className="font-mono text-[12px] text-[var(--color-fg)]">
              {compactAddress(walletAddress)}
            </span>
            {chainBalances?.wallet_explorer_url ? (
              <ExternalLinkButton href={chainBalances.wallet_explorer_url} label="Unichain" />
            ) : null}
            {ogStatus?.wallet_explorer_url ? (
              <ExternalLinkButton href={ogStatus.wallet_explorer_url} label="0G" />
            ) : null}
          </Row>
        ) : null}

        {chainBalances ? (
          <>
            <Separator />
            <h4 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              Unichain Sepolia
            </h4>
            <Row label="USDC">
              <span className="font-mono text-[12px] text-[var(--color-emerald)]">
                {prettyToken(chainBalances.usdc_balance)}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                ${chainBalances.total_notional_usd.toFixed(2)} total ·{' '}
                {(chainBalances.liquid_reserve_ratio * 100).toFixed(1)}% liquid
              </span>
            </Row>
            {chainBalances.state_token ? (
              <Row label={chainBalances.state_token.symbol}>
                <span className="font-mono text-[12px] text-[var(--color-cyan)]">
                  {prettyToken(chainBalances.state_token.balance)}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                  {compactAddress(chainBalances.state_token.address)}
                </span>
              </Row>
            ) : null}
            <Row label="ETH">
              <span className="font-mono text-[12px] text-[var(--color-fg)]">
                {prettyToken(chainBalances.native_balance)}
              </span>
            </Row>
            {chainBalances.bonds.length > 0 ? (
              <>
                <h5 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                  Bond holdings
                </h5>
                <ul className="flex flex-col gap-1">
                  {chainBalances.bonds.map((b) => {
                    const explorerUrl = `https://sepolia.uniscan.xyz/token/${b.address}`;
                    return (
                      <li
                        key={b.bond_id}
                        className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/60 px-3 py-1.5 text-sm"
                      >
                        <a
                          href={explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={`${b.bond_id} · view on Uniscan`}
                          className="inline-flex items-center gap-1 font-mono text-[var(--color-cyan)] hover:underline"
                        >
                          {b.symbol}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-[12px] text-[var(--color-fg)]">
                            ${b.notional_usd.toLocaleString(undefined, {
                              maximumFractionDigits: 0,
                            })}
                          </span>
                          <span
                            className="font-mono text-[10px] text-[var(--color-fg-subtle)]"
                            title="annual coupon"
                          >
                            {(b.coupon_bps / 100).toFixed(2)}% coupon
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <p className="font-mono text-[9.5px] text-[var(--color-fg-subtle)]">
                  bonds held to maturity · principal repaid in USDC
                </p>
              </>
            ) : null}
          </>
        ) : null}

        {ogStatus ? (
          <>
            <Separator />
            <h4 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              0G Galileo
            </h4>
            <Row label="0G gas">
              <span className="font-mono text-[12px] text-[var(--color-fg)]">
                {prettyToken(ogStatus.native_balance)}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                block #{ogStatus.block_number}
              </span>
            </Row>
            {ogStatus.inft ? (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-soft)]/60 px-3 py-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                    iNFT #{ogStatus.inft.token_id}
                  </span>
                  {ogStatus.inft.owner_matches ? (
                    <Badge variant="emerald">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      owner ok
                    </Badge>
                  ) : (
                    <Badge variant="red">
                      <XCircle className="mr-1 h-3 w-3" />
                      mismatch
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
                  <dt className="text-[var(--color-fg-subtle)]">contract</dt>
                  <dd className="truncate text-[var(--color-fg)]">
                    {compactAddress(ogStatus.inft.contract)}
                  </dd>
                  <dt className="text-[var(--color-fg-subtle)]">root</dt>
                  <dd className="truncate text-[var(--color-fg)]">
                    {compactHash(ogStatus.inft.root_hash)}
                  </dd>
                  <dt className="text-[var(--color-fg-subtle)]">tokenURI</dt>
                  <dd className="truncate text-[var(--color-fg)]">{ogStatus.inft.onchain_uri}</dd>
                  {ogStatus.inft.explorer_token_url ? (
                    <>
                      <dt className="text-[var(--color-fg-subtle)]">view</dt>
                      <dd className="truncate">
                        <a
                          href={ogStatus.inft.explorer_token_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                        >
                          chainscan
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        {ogStatus.inft.explorer_storage_url ? (
                          <>
                            {' · '}
                            <a
                              href={ogStatus.inft.explorer_storage_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                            >
                              storagescan
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </>
                        ) : null}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {ogStatus.latest_anchor ? (
                  <div className="mt-2 border-t border-[var(--color-border)] pt-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-violet)]">
                        latest anchor · tick #{ogStatus.latest_anchor.tick_count}
                      </span>
                      <Badge variant="violet" className="font-mono">
                        {ogStatus.latest_anchor.reason}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
                      <dt className="text-[var(--color-fg-subtle)]">root</dt>
                      <dd className="truncate text-[var(--color-fg)]">
                        {compactHash(ogStatus.latest_anchor.root_hash)}
                      </dd>
                      <dt className="text-[var(--color-fg-subtle)]">links</dt>
                      <dd className="flex flex-wrap items-center gap-2 truncate">
                        {ogStatus.latest_anchor.submission_url ? (
                          <a
                            href={ogStatus.latest_anchor.submission_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                          >
                            blob
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                        {ogStatus.latest_anchor.storage_tx_url ? (
                          <a
                            href={ogStatus.latest_anchor.storage_tx_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                          >
                            storage tx
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                        {ogStatus.latest_anchor.update_metadata_tx_url ? (
                          <a
                            href={ogStatus.latest_anchor.update_metadata_tx_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline"
                          >
                            updateMetadata
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </dd>
                    </dl>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-bg-soft)]/40 px-3 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
        {label}
      </span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

function ExternalLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[var(--color-cyan)] hover:underline font-mono text-[11px]"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function prettyToken(decimal: string): string {
  if (!decimal) return '0';
  const dot = decimal.indexOf('.');
  if (dot === -1) return decimal;
  const head = decimal.slice(0, dot);
  const frac = decimal.slice(dot + 1, dot + 5);
  return `${head}.${frac}`;
}
