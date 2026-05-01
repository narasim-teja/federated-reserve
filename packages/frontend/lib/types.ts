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
  };
  latest_fed_rate: {
    rate_bps: number;
    rationale: string;
    received_at: string;
  } | null;
  states: StateView[];
  events: ObserverEvent[];
  infts: InftEntry[];
}
