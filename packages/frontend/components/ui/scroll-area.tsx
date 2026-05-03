'use client';

import { cn } from '@/lib/utils';
import { type HTMLAttributes, forwardRef } from 'react';

// Native-overflow scroll container. We previously wrapped Radix's ScrollArea
// here, but its Viewport relies on percentage heights — which collapse to
// `auto` when the consumer only sets `max-h-*` on the root. The native
// scrollbar is already themed in globals.css, so a plain `overflow-y-auto`
// div scrolls reliably with `max-h-*`, `h-*`, or flex-constrained heights.
const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('relative overflow-y-auto overflow-x-hidden', className)}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
