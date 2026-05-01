'use client';

import { useEffect, useState } from 'react';

/**
 * UTC tick at 1 Hz. SSR-safe — first paint shows nothing until mounted to
 * avoid hydration mismatch on the seconds digit.
 */
export function useUtcClock(): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return '—— —— ——';
  const day = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
  const date = now
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
    .toUpperCase();
  const time = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
  return `${day}, ${date} ${time} UTC`;
}
