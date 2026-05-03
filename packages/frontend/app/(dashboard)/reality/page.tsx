'use client';

import { Construction, ScrollText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * Mode 5 — "Compare to reality" — placeholder.
 *
 * The full historical-comparison engine is post-hackathon work: it needs
 * frozen FOMC + state treasury action data, an outcome model, and a way
 * to scrub through periods. For now we stub a Coming Soon hero so the
 * tab isn't a dead end, with a brief preview of the planned vignette.
 */
export default function RealityPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto max-w-[1100px]">
        <Card>
          <CardHeader>
            <CardTitle>
              <ScrollText className="h-3.5 w-3.5 text-[var(--color-amber)]" />
              Compare to reality
            </CardTitle>
            <Badge variant="amber">coming soon</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* Hero — what's being built and why it isn't here yet */}
            <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-[var(--color-amber)]/40 bg-[var(--color-amber)]/[0.04] p-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-amber)]/40 bg-[var(--color-bg-soft)]">
                <Construction className="h-5 w-5 text-[var(--color-amber)]" />
              </div>
              <div className="flex max-w-xl flex-col gap-2">
                <h2 className="font-mono text-[14px] uppercase tracking-[0.18em] text-[var(--color-fg)]">
                  Historical benchmark engine
                </h2>
                <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
                  Replay any historical period (2008 GFC, March 2020 COVID, regional crises) and
                  watch the federation reason against it side-by-side with what real policymakers
                  did. Outcome scoring against realized macro data, per-agent dossiers, and a
                  scrubbable timeline are all in scope.
                </p>
                <p className="text-[12px] italic text-[var(--color-fg-subtle)]">
                  Needs: frozen FOMC dataset · state treasury action archive · outcome model. Out
                  of scope for the demo build.
                </p>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Link
                  href="/negotiations"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-cyan)] hover:bg-[var(--color-cyan)]/20"
                >
                  <Sparkles className="h-3 w-3" />
                  Watch live negotiations instead
                </Link>
                <Link
                  href="/"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  Back to live mesh
                </Link>
              </div>
            </div>

            <Separator />

            {/* Preview — what one historical vignette would look like */}
            <div>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
                Preview · Q1 2020 vignette
              </h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)]/50 p-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
                      Real Fed action — March 2020
                    </h4>
                    <Badge variant="muted">FOMC</Badge>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-fg)]">
                    Cut federal funds rate from 1.50–1.75% to 0–0.25% over two emergency moves
                    (Mar 3, Mar 15). Restarted QE; opened dollar swap lines with foreign central
                    banks. Deliberate and aggressive.
                  </p>
                </div>
                <div className="rounded border border-[var(--color-violet)]/40 bg-[var(--color-violet)]/5 p-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-violet)]">
                      Mesh response (simulated)
                    </h4>
                    <Badge variant="violet">FED + 8 deeps</Badge>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-fg)]">
                    FED agent cuts in 50bps steps until aggregate unemployment expectation peaks.
                    MA + NY convene a Northeast bond facility; CA pre-funds wildfire reserves; FL
                    and TX activate the gulf-disaster pool.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
