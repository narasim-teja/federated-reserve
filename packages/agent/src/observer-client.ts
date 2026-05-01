/**
 * Observer telemetry client.
 *
 * The agent → observer monitoring channel. The MCP fabric already gives the
 * observer broadcast events (indicator, fed rate). For everything else the
 * UI needs to render — multi-turn negotiation rounds, on-chain swap
 * settlements, NOAA shock injections, reflections — the executor calls
 * the observer's HTTP `/events/*` ingress. Fire-and-forget; failures
 * are logged once and never block agent work.
 */

const NEG_PATH = '/events/negotiation-round';
const SWAP_PATH = '/events/swap-executed';
const SHOCK_PATH = '/events/shock-injected';
const REFLECTION_PATH = '/events/reflection';

export interface NegotiationRoundEnvelope {
  task_id: string;
  context_id?: string | null;
  skill: string;
  round: number;
  from_fips: number;
  to_fips?: number | null;
  stage:
    | 'proposal'
    | 'counter'
    | 'accept'
    | 'reject'
    | 'settlement'
    | 'coalition_join'
    | 'coalition_decline'
    | 'coalition_counter';
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
}

export interface SwapExecutedEnvelope {
  from_fips: number;
  to_fips: number;
  give: { asset: string; amount: string };
  receive: { asset: string; amount: string };
  tx_hash: string;
  explorer_url?: string;
}

export interface ShockInjectedEnvelope {
  state_fips: number;
  shock_kind: string;
  event_type: string;
  severity: number;
  source: string;
}

export interface ReflectionEnvelope {
  state_fips: number;
  state_abbr: string;
  summary: string;
  tick: number | null;
}

export class ObserverTelemetry {
  private readonly base: string;
  private readonly enabled: boolean;
  private warned = false;

  constructor(baseUrl: string | undefined) {
    this.base = (baseUrl ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
    this.enabled = baseUrl !== 'disabled';
  }

  reportNegotiationRound(payload: NegotiationRoundEnvelope): void {
    void this.post(NEG_PATH, payload);
  }

  reportSwapExecuted(payload: SwapExecutedEnvelope): void {
    void this.post(SWAP_PATH, payload);
  }

  reportShockInjected(payload: ShockInjectedEnvelope): void {
    void this.post(SHOCK_PATH, payload);
  }

  reportReflection(payload: ReflectionEnvelope): void {
    void this.post(REFLECTION_PATH, payload);
  }

  private async post(path: string, body: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[observer-telemetry] ${path} unreachable: ${(err as Error).message}`);
      }
    }
  }
}
