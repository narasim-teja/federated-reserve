'use client';

import { useEffect, useState } from 'react';
import { observerApi } from '@/lib/api';
import type { AgentDossier, AgentLogEntry } from '@/lib/types';

interface UseAgentDossier {
  data: AgentDossier | null;
  log: AgentLogEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 7_000;

export function useAgentDossier(abbr: string | null): UseAgentDossier {
  const [data, setData] = useState<AgentDossier | null>(null);
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!abbr) {
      setData(null);
      setLog([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([observerApi.agent(abbr), observerApi.agentLog(abbr)])
      .then(([dossier, logRes]) => {
        if (cancelled) return;
        setData(dossier);
        setLog(logRes.entries);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    const id = setInterval(() => setTick((t) => t + 1), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [abbr, tick]);

  return {
    data,
    log,
    loading,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}
