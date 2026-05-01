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
  | 'system_event'
  | 'negotiation_round'
  | 'swap_executed'
  | 'shock_injected'
  | 'reflection';

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

export interface FedRateHistoryEntry extends FedRateView {
  /** Monotonic id so the UI can dedup. */
  id: number;
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

export interface NegotiationRoundPayload {
  task_id: string;
  context_id?: string | null;
  skill: string;
  round: number;
  /** Speaker FIPS (the agent emitting this round). */
  from_fips: number;
  /** Counterparty FIPS, if known. */
  to_fips?: number | null;
  stage: NegotiationStage;
  /** One short sentence — the LLM rationale or status text. */
  summary: string;
  /** Optional structured terms — varies by stage. */
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
  rounds: NegotiationRoundPayload[];
  started_at: string;
  last_at: string;
}

export interface SwapExecutedPayload {
  from_fips: number;
  to_fips: number;
  give: { asset: string; amount: string };
  receive: { asset: string; amount: string };
  tx_hash: string;
  explorer_url?: string;
  emitted_at: string;
}

export interface ShockInjectedPayload {
  state_fips: number;
  shock_kind: string;
  event_type: string;
  severity: number;
  source: string;
  emitted_at: string;
}

export interface ReflectionPayload {
  state_fips: number;
  state_abbr: string;
  summary: string;
  tick: number | null;
  emitted_at: string;
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
    swaps_executed: number;
    negotiations_open: number;
    shocks_active: number;
  };
  latest_fed_rate: FedRateView | null;
  states: StateDashboardView[];
  events: ObserverEvent[];
  infts: InftManifestEntry[];
  /** Recent fed rate history (oldest → newest). */
  fed_rate_history: FedRateHistoryEntry[];
  /** Most recent reflection per agent — one entry per state, latest only. */
  reflections: ReflectionPayload[];
  /** Active or recently-settled negotiations. */
  negotiations: NegotiationView[];
  /** Recent swap settlements. */
  swaps: SwapExecutedPayload[];
  /** Currently active NOAA shocks the FED has injected. */
  shocks: ShockInjectedPayload[];
}
