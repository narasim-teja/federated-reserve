import type {
  AgentDossier,
  AgentLogEntry,
  FedRateHistoryEntry,
  NegotiationView,
  ShockEvent,
  SwapEvent,
} from '@/lib/types';

const HTTP_URL = process.env.NEXT_PUBLIC_OBSERVER_HTTP_URL ?? 'http://127.0.0.1:3001';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const observerApi = {
  agent: (abbr: string) => getJson<AgentDossier>(`/agent/${abbr}`),
  agentLog: (abbr: string, limit = 80) =>
    getJson<{ entries: AgentLogEntry[] }>(`/agent/${abbr}/log?limit=${limit}`),
  fedRateHistory: () => getJson<{ entries: FedRateHistoryEntry[] }>(`/fed/rate-history`),
  negotiations: () => getJson<{ entries: NegotiationView[] }>(`/negotiations`),
  swaps: () => getJson<{ entries: SwapEvent[] }>(`/swaps`),
  shocks: () => getJson<{ entries: ShockEvent[] }>(`/shocks`),
};
