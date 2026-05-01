import { type VariantProps, cva } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
  {
    variants: {
      variant: {
        default: 'border-[var(--color-border-strong)] bg-[var(--color-surface-elevated)] text-[var(--color-fg)]',
        muted: 'border-transparent bg-[var(--color-bg-soft)] text-[var(--color-fg-muted)]',
        emerald:
          'border-[color-mix(in_oklch,var(--color-emerald)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-emerald)_18%,transparent)] text-[var(--color-emerald)]',
        amber:
          'border-[color-mix(in_oklch,var(--color-amber)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-amber)_18%,transparent)] text-[var(--color-amber)]',
        red:
          'border-[color-mix(in_oklch,var(--color-red)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-red)_18%,transparent)] text-[var(--color-red)]',
        cyan:
          'border-[color-mix(in_oklch,var(--color-cyan)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-cyan)_18%,transparent)] text-[var(--color-cyan)]',
        violet:
          'border-[color-mix(in_oklch,var(--color-violet)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_18%,transparent)] text-[var(--color-violet)]',
        rose:
          'border-[color-mix(in_oklch,var(--color-rose)_55%,transparent)] bg-[color-mix(in_oklch,var(--color-rose)_18%,transparent)] text-[var(--color-rose)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
