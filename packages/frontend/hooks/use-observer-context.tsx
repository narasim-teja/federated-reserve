'use client';

/**
 * Provider so every mode tab shares one WebSocket subscription / one snapshot.
 * Without this, navigating between Live and Agent tabs would tear down the
 * socket on every route change.
 */

import { createContext, type ReactNode, useContext } from 'react';
import { useObserver, type UseObserverResult } from '@/hooks/use-observer';

const Ctx = createContext<UseObserverResult | null>(null);

export function ObserverProvider({ children }: { children: ReactNode }) {
  const value = useObserver();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useObserverContext(): UseObserverResult {
  const v = useContext(Ctx);
  if (!v) throw new Error('useObserverContext: missing provider');
  return v;
}
