export function formatUsd(value: number | null | undefined, opts?: { compact?: boolean }): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    notation: opts?.compact === false ? 'standard' : value > 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

export function formatRatio(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 1500) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function compactAddress(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function compactHash(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length < 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
