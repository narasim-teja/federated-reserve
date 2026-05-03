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
    timeZone: 'America/New_York',
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

/**
 * Render a raw on-chain integer amount in human units, picking decimals
 * from the asset symbol. USDC is 6, all *-TOKEN state Treasury Tokens are 18.
 * Falls back to 18 for anything else with a token-like symbol, or 0 (raw) for
 * plain symbols we don't recognise.
 */
export function formatTokenAmount(raw: string, asset: string): string {
  const decimals = asset.toUpperCase() === 'USDC' ? 6 : 18;
  try {
    const big = BigInt(raw);
    const divisor = 10n ** BigInt(decimals);
    const whole = big / divisor;
    const frac = big % divisor;
    const wholeNum = Number(whole);
    if (wholeNum >= 1_000_000) return `${(wholeNum / 1_000_000).toFixed(2)}M`;
    if (wholeNum >= 1_000) return `${(wholeNum / 1_000).toFixed(1)}k`;
    if (wholeNum >= 1) {
      // Show up to 2 decimals of precision when small.
      const fracStr = (Number(frac) / Number(divisor)).toFixed(2).slice(2);
      return fracStr === '00' ? `${wholeNum}` : `${wholeNum}.${fracStr}`;
    }
    // Sub-unit amounts: render as 0.xxxx (4dp).
    const fracStr = (Number(big) / Number(divisor)).toFixed(4);
    return fracStr;
  } catch {
    return raw;
  }
}
