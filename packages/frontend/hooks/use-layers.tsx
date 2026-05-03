'use client';

import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useReducer,
} from 'react';

export type LayerKey =
  | 'indicators'
  | 'fed_rate'
  | 'peer_updates'
  | 'inft_mints'
  | 'shocks'
  | 'coalitions'
  | 'deep_only';

export interface LayerDef {
  key: LayerKey;
  label: string;
  icon: 'pulse' | 'bank' | 'radio' | 'wallet' | 'storm' | 'handshake' | 'star';
  hint: string;
  /** Maps the layer to the event kinds it filters in the feed (if any). */
  eventKinds?: string[];
  /** When true, layer only affects map appearance, not the feed. */
  mapOnly?: boolean;
}

export const LAYERS: LayerDef[] = [
  {
    key: 'indicators',
    label: 'Indicator broadcasts',
    icon: 'pulse',
    hint: 'BLS, BEA, Census, FRED snapshots fanned over MCP',
    eventKinds: ['indicator_received'],
  },
  {
    key: 'fed_rate',
    label: 'FED rate broadcasts',
    icon: 'bank',
    hint: 'announce_fed_rate fan-outs from the Federal Reserve agent',
    eventKinds: ['fed_rate_received'],
  },
  {
    key: 'peer_updates',
    label: 'Mesh peer updates',
    icon: 'radio',
    hint: 'AXL topology refreshes — joins, drops, peer pubkey rotations',
    eventKinds: ['peer_update'],
  },
  {
    key: 'inft_mints',
    label: 'iNFT manifest sync',
    icon: 'wallet',
    hint: '0G persona/memory commitments published by agents',
    eventKinds: ['inft_manifest_updated'],
  },
  {
    key: 'shocks',
    label: 'NOAA shock events',
    icon: 'storm',
    hint: 'Storm / wildfire signals routed through the data plane',
    eventKinds: ['shock_injected', 'system_event'],
  },
  {
    key: 'coalitions',
    label: 'Coalition + settlements',
    icon: 'handshake',
    hint: 'A2A negotiation rounds, on-chain swap settlements, agent reflections',
    eventKinds: ['negotiation_round', 'swap_executed', 'reflection'],
  },
  {
    key: 'deep_only',
    label: 'Deep agents only',
    icon: 'star',
    hint: 'Hide observer-tier states; show only the 8 hand-tuned deep agents',
    mapOnly: true,
  },
];

type LayerState = Record<LayerKey, boolean>;

const INITIAL: LayerState = {
  indicators: true,
  fed_rate: true,
  // Housekeeping events default OFF so the feed leads with real activity
  // (broadcasts, negotiations, swaps, shocks). Toggle on if you want to
  // watch the mesh topology / iNFT manifest churn.
  peer_updates: false,
  inft_mints: false,
  shocks: true,
  coalitions: true,
  deep_only: false,
};

type Action = { type: 'toggle'; key: LayerKey } | { type: 'set'; key: LayerKey; value: boolean };

function reducer(state: LayerState, action: Action): LayerState {
  switch (action.type) {
    case 'toggle':
      return { ...state, [action.key]: !state[action.key] };
    case 'set':
      return { ...state, [action.key]: action.value };
    default:
      return state;
  }
}

interface LayerContextValue {
  layers: LayerState;
  toggle: (key: LayerKey) => void;
  set: (key: LayerKey, value: boolean) => void;
  /** Pre-computed set of allowed event kinds derived from active layers. */
  allowedEventKinds: Set<string>;
}

const LayerContext = createContext<LayerContextValue | null>(null);

export function LayerProvider({ children }: { children: ReactNode }) {
  const [layers, dispatch] = useReducer(reducer, INITIAL);
  const value = useMemo<LayerContextValue>(() => {
    const allowed = new Set<string>();
    for (const def of LAYERS) {
      if (def.mapOnly) continue;
      if (!layers[def.key]) continue;
      for (const k of def.eventKinds ?? []) allowed.add(k);
    }
    // Always allow mesh_snapshot as a heartbeat
    allowed.add('mesh_snapshot');
    return {
      layers,
      toggle: (key) => dispatch({ type: 'toggle', key }),
      set: (key, value) => dispatch({ type: 'set', key, value }),
      allowedEventKinds: allowed,
    };
  }, [layers]);
  return <LayerContext.Provider value={value}>{children}</LayerContext.Provider>;
}

export function useLayers(): LayerContextValue {
  const ctx = useContext(LayerContext);
  if (!ctx) throw new Error('useLayers must be used within <LayerProvider>');
  return ctx;
}
