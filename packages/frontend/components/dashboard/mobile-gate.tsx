'use client';

import { Monitor, X } from 'lucide-react';
import { useState } from 'react';

export function MobileGate() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--color-bg)]/95 backdrop-blur-md p-6 text-center md:hidden">
      <div className="relative w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/80 p-6 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.7)]">
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Continue on mobile"
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-elevated)] hover:text-[var(--color-fg)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]">
          <Monitor className="h-5 w-5" />
        </div>
        <h2 className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-[var(--color-fg)]">
          Best on desktop
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
          Federated Reserve is a dense, multi-pane intelligence dashboard built for wide screens.
          Mobile layouts are not yet optimized — open this page on a desktop or laptop for the full
          experience.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="mt-4 inline-flex items-center justify-center rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-elevated)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
