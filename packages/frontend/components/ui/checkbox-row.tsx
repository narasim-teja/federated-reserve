'use client';

import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/utils';

interface CheckboxRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  icon: ReactNode;
  label: string;
  hint?: string;
  accent?: 'cyan' | 'emerald' | 'amber' | 'red' | 'violet' | 'rose';
}

const ACCENT: Record<NonNullable<CheckboxRowProps['accent']>, string> = {
  cyan: 'text-[var(--color-cyan)]',
  emerald: 'text-[var(--color-emerald)]',
  amber: 'text-[var(--color-amber)]',
  red: 'text-[var(--color-red)]',
  violet: 'text-[var(--color-violet)]',
  rose: 'text-[var(--color-rose)]',
};

const ACCENT_BORDER: Record<NonNullable<CheckboxRowProps['accent']>, string> = {
  cyan: 'border-[color-mix(in_oklch,var(--color-cyan)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-cyan)_25%,transparent)]',
  emerald: 'border-[color-mix(in_oklch,var(--color-emerald)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-emerald)_25%,transparent)]',
  amber: 'border-[color-mix(in_oklch,var(--color-amber)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-amber)_25%,transparent)]',
  red: 'border-[color-mix(in_oklch,var(--color-red)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-red)_25%,transparent)]',
  violet: 'border-[color-mix(in_oklch,var(--color-violet)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_25%,transparent)]',
  rose: 'border-[color-mix(in_oklch,var(--color-rose)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-rose)_25%,transparent)]',
};

export function CheckboxRow({
  checked,
  onChange,
  icon,
  label,
  hint,
  accent = 'cyan',
}: CheckboxRowProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] transition-colors',
        'hover:bg-[var(--color-surface)]/60',
        checked ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]',
      )}
      title={hint}
    >
      <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          className="peer sr-only"
        />
        <span
          className={cn(
            'h-3.5 w-3.5 rounded-[3px] border transition-colors',
            checked
              ? ACCENT_BORDER[accent]
              : 'border-[var(--color-border-strong)] bg-[var(--color-bg)]',
          )}
        />
        {checked && (
          <svg
            viewBox="0 0 12 12"
            className={cn('absolute h-3 w-3', ACCENT[accent])}
            aria-hidden
          >
            <path
              d="M2.5 6.2 5 8.6 9.7 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded',
          checked ? ACCENT[accent] : 'text-[var(--color-fg-subtle)]',
        )}
      >
        {icon}
      </span>
      <span className="flex-1 truncate font-mono text-[11px] uppercase tracking-[0.08em]">
        {label}
      </span>
    </label>
  );
}
