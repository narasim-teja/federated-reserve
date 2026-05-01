'use client';

import { ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * Mode 5 placeholder. The full "agent vs reality" engine is non-trivial:
 * it needs frozen historical FOMC + state treasury action data plus an
 * outcome model. For the demo we surface a single hand-curated vignette
 * (Q1 2020 unemployment shock) so the mode tab isn't a dead end. The
 * full feature lands post-hackathon.
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
            <Badge variant="amber">vignette · Q1 2020</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">
              A full historical-comparison engine is on the roadmap. This vignette shows how the
              federation would have reacted to the March 2020 unemployment shock, side-by-side
              with the actual policymaker decisions.
            </p>

            <Separator />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-soft)]/50 p-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
                    Real Fed action — March 2020
                  </h3>
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
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-violet)]">
                    Mesh response (simulated)
                  </h3>
                  <Badge variant="violet">FED agent + 8 deeps</Badge>
                </div>
                <p className="mt-2 text-[12px] text-[var(--color-fg)]">
                  FED agent cuts in steps of 50bps until aggregate unemployment expectation peaks.
                  MA + NY convene a Northeast bond facility; CA pre-funds wildfire reserves; FL
                  and TX activate gulf-disaster pool. Decisions arrive as multi-turn coalition
                  threads inside <span className="font-mono text-[var(--color-cyan)]">/negotiations</span>.
                </p>
              </div>
            </div>

            <p className="text-[11px] italic text-[var(--color-fg-subtle)]">
              The full mode will let you scrub through historical periods, toggle individual
              states, and see outcome scoring against actual realized macro data.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
