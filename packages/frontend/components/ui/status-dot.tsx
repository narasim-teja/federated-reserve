import type { Health } from '@/lib/types';
import { cn } from '@/lib/utils';

const COLOR: Record<Health, string> = {
  green: 'bg-[var(--color-emerald)]',
  amber: 'bg-[var(--color-amber)]',
  red: 'bg-[var(--color-red)]',
  unknown: 'bg-[var(--color-fg-subtle)]',
};

const RING: Record<Health, string> = {
  green: 'bg-[var(--color-emerald)]/40',
  amber: 'bg-[var(--color-amber)]/40',
  red: 'bg-[var(--color-red)]/40',
  unknown: 'bg-[var(--color-fg-subtle)]/30',
};

export function StatusDot({
  health,
  pulse = false,
  size = 8,
  className,
}: {
  health: Health;
  pulse?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span
          className={cn('pulse-ring absolute inset-0 rounded-full', RING[health])}
          aria-hidden
        />
      )}
      <span className={cn('relative h-full w-full rounded-full', COLOR[health])} />
    </span>
  );
}
