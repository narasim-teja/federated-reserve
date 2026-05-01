'use client';

import { Activity, BadgeDollarSign, Radio, Server, WalletCards } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

type Health = 'unknown' | 'green' | 'amber' | 'red';

interface ObserverEvent {
  id: number;
  kind: string;
  timestamp: string;
  payload: unknown;
}

interface StateView {
  fips: number;
  abbr: string;
  name: string;
  region: string;
  tier: string;
  health: Health;
  reserve_ratio: number | null;
  total_value_usd: number | null;
  latest_indicator: {
    indicator: string;
    value: number;
    source: string;
    received_at: string;
  } | null;
  composition: Array<{ asset: string; balance: string }>;
  tick_count: number | null;
}

interface InftEntry {
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

interface Snapshot {
  generated_at: string;
  mesh: { observer_pubkey: string; peer_count: number; last_refresh_at: string | null };
  metrics: { messages_seen: number; messages_per_minute: number; total_known_tvl_usd: number };
  latest_fed_rate: { rate_bps: number; rationale: string; received_at: string } | null;
  states: StateView[];
  events: ObserverEvent[];
  infts: InftEntry[];
}

const HTTP_URL = process.env.NEXT_PUBLIC_OBSERVER_HTTP_URL ?? 'http://127.0.0.1:3001';
const WS_URL = process.env.NEXT_PUBLIC_OBSERVER_WS_URL ?? 'ws://127.0.0.1:3001/ws';

const REGION_ORDER = ['northeast', 'midwest', 'south', 'west', 'territory'];
const FALLBACK_STATE_ROWS: Array<[string, string, string]> = [
  ['AK', 'Alaska', 'west'],
  ['CA', 'California', 'west'],
  ['FL', 'Florida', 'south'],
  ['IL', 'Illinois', 'midwest'],
  ['MA', 'Massachusetts', 'northeast'],
  ['NY', 'New York', 'northeast'],
  ['TX', 'Texas', 'south'],
  ['WA', 'Washington', 'west'],
];

const DEEP_STATE_FALLBACKS: StateView[] = FALLBACK_STATE_ROWS.map(
  ([abbr, name, region], index) => ({
    fips: index + 1,
    abbr,
    name,
    region,
    tier: 'deep',
    health: 'unknown',
    reserve_ratio: null,
    total_value_usd: null,
    latest_indicator: null,
    composition: [],
    tick_count: null,
  }),
);

const INFT_FALLBACKS: InftEntry[] = DEEP_STATE_FALLBACKS.map((state) => ({
  state_abbr: state.abbr,
  state_name: state.name,
  owner_address: '',
  token_id: null,
  mint_status: 'pending_0g',
  metadata_uri: 'pending manifest',
  metadata_hash: 'pending',
  persona_tagline: `${state.name} deep-state agent metadata will load from the observer manifest.`,
  contract: { chain: '0g-testnet', address: '', explorer_url: '' },
}));

function compactAddress(value: string): string {
  if (!value) return 'pending';
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatUsd(value: number | null): string {
  if (value == null) return 'unknown';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    notation: value > 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function formatTime(value: string | null | undefined): string {
  if (!value) return 'none yet';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function eventTitle(event: ObserverEvent): string {
  if (event.kind === 'indicator_received') {
    const p = event.payload as { state_fips?: number; indicator?: string; value?: number };
    return `Indicator ${p.indicator ?? 'unknown'}=${p.value ?? '?'}`;
  }
  if (event.kind === 'fed_rate_received') {
    const p = event.payload as { rate_bps?: number };
    return `FED rate ${p.rate_bps ?? '?'}bps`;
  }
  if (event.kind === 'peer_update') {
    const p = event.payload as { peer_count?: number };
    return `Mesh peers ${p.peer_count ?? 0}`;
  }
  if (event.kind === 'inft_manifest_updated') return 'iNFT manifest loaded';
  return event.kind.replaceAll('_', ' ');
}

export default function DashboardPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<ObserverEvent[]>([]);
  const [selectedAbbr, setSelectedAbbr] = useState('MA');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch(`${HTTP_URL}/snapshot`);
        if (!res.ok) return;
        const data = (await res.json()) as Snapshot;
        if (!ignore) {
          setSnapshot(data);
          setEvents(data.events ?? []);
        }
      } catch {
        // The WS retry below will keep the dashboard alive once observer starts.
      }
    }
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => setConnected(false);
      ws.onmessage = (message) => {
        const event = JSON.parse(message.data as string) as ObserverEvent;
        if (event.kind === 'mesh_snapshot') {
          const next = event.payload as Snapshot;
          setSnapshot(next);
          setEvents(next.events ?? []);
          return;
        }
        setEvents((current) => [event, ...current].slice(0, 100));
        if (event.kind === 'indicator_received' || event.kind === 'fed_rate_received') {
          void fetch(`${HTTP_URL}/snapshot`)
            .then(
              async (r): Promise<Snapshot | null> => (r.ok ? ((await r.json()) as Snapshot) : null),
            )
            .then((data: Snapshot | null) => {
              if (data) setSnapshot(data);
            });
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const states = snapshot?.states.length ? snapshot.states : DEEP_STATE_FALLBACKS;
  const selected = states.find((s) => s.abbr === selectedAbbr) ?? states[0] ?? null;
  const groupedStates = useMemo(
    () =>
      REGION_ORDER.map((region) => ({
        region,
        states: states
          .filter((s) => s.region === region)
          .sort((a, b) => a.abbr.localeCompare(b.abbr)),
      })).filter((group) => group.states.length > 0),
    [states],
  );

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Federated Reserve</p>
          <h1>Live AXL Mesh Observer</h1>
        </div>
        <div className="metric-strip">
          <Metric icon={<Server />} label="Peers" value={String(snapshot?.mesh.peer_count ?? 0)} />
          <Metric
            icon={<Activity />}
            label="Msg/min"
            value={String(snapshot?.metrics.messages_per_minute ?? 0)}
          />
          <Metric
            icon={<BadgeDollarSign />}
            label="Known TVL"
            value={formatUsd(snapshot?.metrics.total_known_tvl_usd ?? null)}
          />
          <Metric
            icon={<Radio />}
            label="FED"
            value={
              snapshot?.latest_fed_rate ? `${snapshot.latest_fed_rate.rate_bps}bps` : 'waiting'
            }
          />
        </div>
        <div className={`ws-pill ${connected ? 'ok' : 'down'}`}>
          {connected ? 'WS live' : 'WS retrying'}
        </div>
      </header>

      <section className="workspace">
        <aside className="feed-panel" aria-label="Live mesh event feed">
          <div className="panel-title">
            <Radio size={17} />
            <span>AXL Feed</span>
          </div>
          <div className="event-list">
            {events.length === 0 ? (
              <div className="empty">Waiting for mesh traffic</div>
            ) : (
              events.map((event) => (
                <article className={`event ${event.kind}`} key={`${event.id}-${event.timestamp}`}>
                  <time>{formatTime(event.timestamp)}</time>
                  <strong>{eventTitle(event)}</strong>
                  <span>{event.kind}</span>
                </article>
              ))
            )}
          </div>
        </aside>

        <section className="map-panel" aria-label="State health map">
          <div className="map-header">
            <div>
              <p className="eyebrow">State Health</p>
              <h2>8 deep agents plus observer-class states</h2>
            </div>
            <span className="updated">Updated {formatTime(snapshot?.generated_at)}</span>
          </div>
          <div className="state-map">
            {groupedStates.map((group) => (
              <div className="region-band" key={group.region}>
                <span className="region-label">{group.region}</span>
                <div className="state-grid">
                  {group.states.map((state) => (
                    <button
                      className={`state-tile ${state.health} ${state.tier} ${selected?.abbr === state.abbr ? 'selected' : ''}`}
                      key={state.abbr}
                      onClick={() => setSelectedAbbr(state.abbr)}
                      type="button"
                      title={`${state.name}: ${state.health}`}
                    >
                      <span>{state.abbr}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <FocusedState state={selected} />
        </section>

        <aside className="inft-panel" aria-label="iNFT manifest panel">
          <div className="panel-title">
            <WalletCards size={17} />
            <span>iNFT Manifest</span>
          </div>
          <div className="inft-list">
            {(snapshot?.infts.length ? snapshot.infts : INFT_FALLBACKS).map((entry) => (
              <article className="inft-card" key={entry.state_abbr}>
                <div>
                  <strong>{entry.state_abbr}</strong>
                  <span>{entry.mint_status}</span>
                </div>
                <p>{entry.persona_tagline}</p>
                <dl>
                  <dt>Owner</dt>
                  <dd>{compactAddress(entry.owner_address)}</dd>
                  <dt>Hash</dt>
                  <dd>{compactAddress(entry.metadata_hash)}</dd>
                </dl>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FocusedState({ state }: { state: StateView | null }) {
  if (!state) {
    return <div className="focus-panel empty">Observer snapshot has not arrived yet</div>;
  }
  return (
    <div className="focus-panel">
      <div>
        <p className="eyebrow">Focused State</p>
        <h3>
          {state.name} <span>{state.abbr}</span>
        </h3>
      </div>
      <div className="focus-grid">
        <div>
          <span>Reserve ratio</span>
          <strong>
            {state.reserve_ratio == null ? 'unknown' : `${(state.reserve_ratio * 100).toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <span>Total value</span>
          <strong>{formatUsd(state.total_value_usd)}</strong>
        </div>
        <div>
          <span>Tick</span>
          <strong>{state.tick_count ?? 'none'}</strong>
        </div>
        <div>
          <span>Latest indicator</span>
          <strong>
            {state.latest_indicator
              ? `${state.latest_indicator.indicator} ${state.latest_indicator.value}`
              : 'waiting'}
          </strong>
        </div>
      </div>
    </div>
  );
}
