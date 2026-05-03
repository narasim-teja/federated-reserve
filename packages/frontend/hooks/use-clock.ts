'use client';

import { useEffect, useState } from 'react';

const TZ = 'America/New_York';

/**
 * Eastern-time tick at 1 Hz. Uses America/New_York so the label
 * automatically swings between EDT and EST with daylight savings.
 * SSR-safe — first paint shows nothing until mounted to avoid
 * hydration mismatch on the seconds digit.
 */
export function useUtcClock(): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return '—— —— ——';
  const day = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ }).toUpperCase();
  const date = now
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: TZ,
    })
    .toUpperCase();
  const time = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ });
  // Extract the live tz abbreviation (EDT in summer, EST in winter).
  const tzLabel =
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'ET';
  return `${day}, ${date} ${time} ${tzLabel}`;
}
