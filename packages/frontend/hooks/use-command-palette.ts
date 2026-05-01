'use client';

import { useEffect, useState } from 'react';

/**
 * Global ⌘K / Ctrl+K listener. Wired in the dashboard layout so every
 * mode tab can open the palette.
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isAccel = e.metaKey || e.ctrlKey;
      if (isAccel && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen, toggle: () => setOpen((v) => !v) };
}
