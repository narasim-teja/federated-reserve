'use client';

import { useEffect, useReducer, useRef } from 'react';
import type { ObserverEvent, Snapshot } from '@/lib/types';

const HTTP_URL = process.env.NEXT_PUBLIC_OBSERVER_HTTP_URL ?? 'http://127.0.0.1:3001';
const WS_URL = process.env.NEXT_PUBLIC_OBSERVER_WS_URL ?? 'ws://127.0.0.1:3001/ws';

const EVENT_BUFFER = 120;
const POLL_INTERVAL_MS = 10_000;
const RECONNECT_MS = 2000;

type Connection = 'idle' | 'connecting' | 'live' | 'retrying';

interface State {
  snapshot: Snapshot | null;
  events: ObserverEvent[];
  connection: Connection;
  lastUpdated: string | null;
  /** Monotonically increasing pulse counter — UI uses this to flash tiles. */
  pulseFor: Record<number, number>;
}

type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: ObserverEvent }
  | { type: 'connection'; connection: Connection };

const INITIAL_STATE: State = {
  snapshot: null,
  events: [],
  connection: 'idle',
  lastUpdated: null,
  pulseFor: {},
};

function pulseFromEvent(event: ObserverEvent, current: Record<number, number>) {
  const fips = (event.payload as { state_fips?: number } | null)?.state_fips;
  if (typeof fips !== 'number') return current;
  return { ...current, [fips]: (current[fips] ?? 0) + 1 };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return {
        ...state,
        snapshot: action.snapshot,
        events: action.snapshot.events ?? state.events,
        lastUpdated: action.snapshot.generated_at,
      };
    case 'event': {
      const events = [action.event, ...state.events].slice(0, EVENT_BUFFER);
      return {
        ...state,
        events,
        pulseFor: pulseFromEvent(action.event, state.pulseFor),
      };
    }
    case 'connection':
      return { ...state, connection: action.connection };
    default:
      return state;
  }
}

export interface UseObserverResult {
  snapshot: Snapshot | null;
  events: ObserverEvent[];
  connection: Connection;
  lastUpdated: string | null;
  pulseFor: Record<number, number>;
}

export function useObserver(): UseObserverResult {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // HTTP poll — also seeds the very first paint.
  useEffect(() => {
    let cancelled = false;
    const fetchSnapshot = async () => {
      try {
        const res = await fetch(`${HTTP_URL}/snapshot?t=${Date.now()}`);
        if (!res.ok) return;
        const data = (await res.json()) as Snapshot;
        if (!cancelled) dispatchRef.current({ type: 'snapshot', snapshot: data });
      } catch {
        // The WS path will recover once the observer is reachable.
      }
    };
    void fetchSnapshot();
    const id = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Streaming WebSocket — pushes mesh_snapshot + per-event payloads.
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      dispatchRef.current({ type: 'connection', connection: 'connecting' });
      socket = new WebSocket(WS_URL);
      socket.onopen = () => dispatchRef.current({ type: 'connection', connection: 'live' });
      socket.onerror = () => dispatchRef.current({ type: 'connection', connection: 'retrying' });
      socket.onclose = () => {
        dispatchRef.current({ type: 'connection', connection: 'retrying' });
        if (!stopped) retryTimer = setTimeout(connect, RECONNECT_MS);
      };
      socket.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data as string) as ObserverEvent;
          if (event.kind === 'mesh_snapshot') {
            dispatchRef.current({ type: 'snapshot', snapshot: event.payload as Snapshot });
            return;
          }
          dispatchRef.current({ type: 'event', event });
        } catch {
          // Ignore non-JSON frames.
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return state;
}
