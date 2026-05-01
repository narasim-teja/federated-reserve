export type Health = 'unknown' | 'green' | 'amber' | 'red';
export type Tier = 'deep' | 'observer' | 'federal';
export type Region = 'northeast' | 'midwest' | 'south' | 'west' | 'territory' | 'federal';

export interface ObserverEvent<T = unknown> {
  id: number;
  kind: string;
  timestamp: string;
  payload: T;
}

export interface IndicatorPayload {
  state_fips?: number;
  indicator?: string;
  value?: number;
  source?: string;
}

export interface FedRatePayload {
  rate_bps?: number;
  rationale?: string;
  effective?: string;
}

export interface PeerPayload {
  peer_count?: number;
  observer_pubkey?: string;
}

export interface IndicatorView {
  indicator: string;
  value: number;
  source: string;
  received_at: string;
}

export interface CompositionEntry {
  asset: string;
  balance: string;
}

export interface StateView {
  fips: number;
  abbr: string;
  name: string;
  region: Region;
  tier: Tier;
  health: Health;
  reserve_ratio: number | null;
  total_value_usd: number | null;
  latest_indicator: IndicatorView | null;
  composition: CompositionEntry[];
  tick_count: number | null;
  last_seen_at?: string | null;
}

export interface InftEntry {
  state_abbr: string;
  state_name: string;
  owner_address: string;
  token_id: number | null;
  mint_status: string;
  metadata_uri: string;
  metadata_hash: string;
  persona_tagline: string;
  contract: { chain: string; address: string; explorer_url: string };
}

export interface FedRateHistoryEntry {
  id: number;
  rate_bps: number;
  effective: string;
  rationale: string;
  received_at: string;
}

export type NegotiationStage =
  | 'proposal'
  | 'counter'
  | 'accept'
  | 'reject'
  | 'settlement'
  | 'coalition_join'
  | 'coalition_decline'
  | 'coalition_counter';

export interface NegotiationRound {
  task_id: string;
  context_id: string | null;
  skill: string;
  round: number;
  from_fips: number;
  to_fips: number | null;
  stage: NegotiationStage;
  summary: string;
  terms?: {
    give?: { asset: string; amount: string };
    receive?: { asset: string; amount: string };
    contribution_usd?: number;
    duration_days?: number | null;
    coalition_tag?: string;
    tx_hash?: string;
    explorer_url?: string;
  } | null;
  emitted_at: string;
}

export interface NegotiationView {
  task_id: string;
  context_id: string | null;
  skill: string;
  participants: number[];
  status: 'open' | 'settled' | 'rejected' | 'expired';
  rounds: NegotiationRound[];
  started_at: string;
  last_at: string;
}

export interface SwapEvent {
  from_fips: number;
  to_fips: number;
  give: { asset: string; amount: string };
  receive: { asset: string; amount: string };
  tx_hash: string;
  explorer_url?: string;
  emitted_at: string;
}

export interface ShockEvent {
  state_fips: number;
  shock_kind: string;
  event_type: string;
  severity: number;
  source: string;
  emitted_at: string;
}

export interface ReflectionEvent {
  state_fips: number;
  state_abbr: string;
  summary: string;
  tick: number | null;
  emitted_at: string;
}

export interface Snapshot {
  generated_at: string;
  mesh: {
    observer_pubkey: string;
    peer_count: number;
    last_refresh_at: string | null;
  };
  metrics: {
    messages_seen: number;
    messages_per_minute: number;
    total_known_tvl_usd: number;
    swaps_executed: number;
    negotiations_open: number;
    shocks_active: number;
  };
  latest_fed_rate: {
    rate_bps: number;
    rationale: string;
    received_at: string;
  } | null;
  states: StateView[];
  events: ObserverEvent[];
  infts: InftEntry[];
  fed_rate_history: FedRateHistoryEntry[];
  reflections: ReflectionEvent[];
  negotiations: NegotiationView[];
  swaps: SwapEvent[];
  shocks: ShockEvent[];
}

export interface AgentDossier {
  meta: {
    fips: number;
    abbr: string;
    name: string;
    region: string;
    tier: string;
  };
  persona: {
    tagline: string;
    posture: string;
    coalitions: string[];
  };
  live: StateView | null;
  memory: {
    composition?: { asset: string; balance: string }[];
    reserveRatio?: number;
    totalValueUsd?: number;
    tickCount?: number;
    receivedIndicators?: Array<{
      state_fips: number;
      indicator: string;
      value: number;
      timestamp?: string;
      source?: string;
      receivedAt?: string;
    }>;
  } | null;
  credit: {
    rating: string;
    score: number;
    yieldFloorBps: number;
    yieldCeilingBps: number;
    summary: string;
  } | null;
  inft: InftEntry | null;
  negotiations: NegotiationView[];
  swaps: SwapEvent[];
  reflections: ReflectionEvent[];
  latest_reflection: ReflectionEvent | null;
}

export interface AgentLogEntry {
  kind: string;
  at: string;
  summary: string;
  details?: Record<string, unknown>;
}
