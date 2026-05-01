import type {
  EconomicIndicatorKind,
  ShareEconomicIndicatorInput,
  TreasuryAsset,
} from '@federated-reserve/shared';

export type ObserverEventKind =
  | 'mesh_snapshot'
  | 'indicator_received'
  | 'fed_rate_received'
  | 'peer_update'
  | 'inft_manifest_updated'
  | 'system_event';

export interface ObserverEvent<T = unknown> {
  id: number;
  kind: ObserverEventKind;
  timestamp: string;
  payload: T;
}

export interface FedRateView {
  rate_bps: number;
  effective: string;
  rationale: string;
  received_at: string;
}

export interface StateDashboardView {
  fips: number;
  abbr: string;
  name: string;
  region: string;
  tier: string;
  health: 'unknown' | 'green' | 'amber' | 'red';
  reserve_ratio: number | null;
  total_value_usd: number | null;
  composition: TreasuryAsset[];
  latest_indicator: (ShareEconomicIndicatorInput & { received_at: string }) | null;
  indicators: Partial<
    Record<EconomicIndicatorKind, ShareEconomicIndicatorInput & { received_at: string }>
  >;
  tick_count: number | null;
  last_seen_at: string | null;
}

export interface InftManifestEntry {
  state_fips: number;
  state_abbr: string;
  state_name: string;
  owner_address: string;
  token_id: number | null;
  mint_status: 'pending_0g' | 'minted';
  metadata_uri: string;
  metadata_hash: string;
  persona_tagline: string;
  memory_proof: {
    state_file: string;
    log_file: string;
    log_entries_included: number;
    latest_log_timestamp: string | null;
  };
  contract: {
    chain: string;
    chain_id: number;
    address: string;
    explorer_url: string;
  };
}

export interface InftManifest {
  generated_at: string;
  mint_status: 'pending_0g';
  entries: InftManifestEntry[];
}

export interface MeshSnapshot {
  generated_at: string;
  mesh: {
    observer_pubkey: string;
    peer_count: number;
    peers: string[];
    last_refresh_at: string | null;
  };
  metrics: {
    messages_seen: number;
    messages_per_minute: number;
    total_known_tvl_usd: number;
  };
  latest_fed_rate: FedRateView | null;
  states: StateDashboardView[];
  events: ObserverEvent[];
  infts: InftManifestEntry[];
}
