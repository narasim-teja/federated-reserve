import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AnnounceFedRateInput,
  type QueryTreasuryResult,
  STATES,
  type ShareEconomicIndicatorInput,
  type TreasuryAsset,
  lookupStateByFips,
} from '@federated-reserve/shared';
import type {
  FedRateHistoryEntry,
  FedRateView,
  InftManifest,
  InftManifestEntry,
  MeshSnapshot,
  NegotiationRoundPayload,
  NegotiationView,
  ObserverEvent,
  ObserverEventKind,
  ReflectionPayload,
  ShockInjectedPayload,
  StateDashboardView,
  SwapExecutedPayload,
} from './types.ts';

const EVENT_CAP = 240;
const STATE_MEMORY_CAP = 120;
const FED_RATE_HISTORY_CAP = 24;
const SWAP_HISTORY_CAP = 40;
const NEGOTIATION_CAP = 32;
const NEGOTIATION_TTL_MS = 30 * 60 * 1000;
const SHOCK_TTL_MS = 30 * 60 * 1000;

interface MeshView {
  observerPubkey: string;
  peers: string[];
  refreshedAt: string | null;
}

interface MemoryStateFile {
  composition?: TreasuryAsset[];
  reserveRatio?: number;
  totalValueUsd?: number;
  tickCount?: number;
}

export class ObserverStore {
  private readonly states = new Map<number, StateDashboardView>();
  private readonly events: ObserverEvent[] = [];
  private readonly eventTimes: number[] = [];
  private readonly subscribers = new Set<(event: ObserverEvent) => void>();
  private nextEventId = 1;
  private nextHistoryId = 1;
  private latestFedRate: FedRateView | null = null;
  private mesh: MeshView = { observerPubkey: '', peers: [], refreshedAt: null };
  private infts: InftManifestEntry[] = [];
  private readonly fedRateHistory: FedRateHistoryEntry[] = [];
  private readonly negotiations = new Map<string, NegotiationView>();
  private readonly swaps: SwapExecutedPayload[] = [];
  private readonly shocks = new Map<string, ShockInjectedPayload>();
  private readonly reflections = new Map<number, ReflectionPayload>();

  constructor(
    private readonly memoryRoot: string,
    private readonly manifestPath: string,
  ) {
    for (const state of STATES.filter((s) => s.tier !== 'federal')) {
      this.states.set(state.fips, {
        fips: state.fips,
        abbr: state.abbr,
        name: state.name,
        region: state.region,
        tier: state.tier,
        health: 'unknown',
        reserve_ratio: null,
        total_value_usd: null,
        composition: [],
        latest_indicator: null,
        indicators: {},
        tick_count: null,
        last_seen_at: null,
      });
    }
  }

  subscribe(fn: (event: ObserverEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  ingestIndicator(input: ShareEconomicIndicatorInput): void {
    const receivedAt = new Date().toISOString();
    const state = this.ensureState(input.state_fips);
    if (state) {
      const entry = { ...input, received_at: receivedAt };
      state.indicators[input.indicator] = entry;
      state.latest_indicator = entry;
      state.last_seen_at = receivedAt;
      state.health = deriveHealth(state.reserve_ratio, state.indicators.unemployment?.value);
    }
    this.emit('indicator_received', { ...input, received_at: receivedAt });
  }

  ingestFedRate(input: AnnounceFedRateInput): void {
    const view: FedRateView = {
      rate_bps: input.rate_bps,
      effective: input.effective,
      rationale: input.rationale,
      received_at: new Date().toISOString(),
    };
    this.latestFedRate = view;
    const last = this.fedRateHistory[this.fedRateHistory.length - 1];
    if (!last || last.rate_bps !== view.rate_bps || last.effective !== view.effective) {
      this.fedRateHistory.push({ id: this.nextHistoryId++, ...view });
      if (this.fedRateHistory.length > FED_RATE_HISTORY_CAP) {
        this.fedRateHistory.splice(0, this.fedRateHistory.length - FED_RATE_HISTORY_CAP);
      }
    }
    this.emit('fed_rate_received', view);
  }

  ingestNegotiationRound(payload: NegotiationRoundPayload): void {
    const existing = this.negotiations.get(payload.task_id);
    const now = payload.emitted_at;
    if (!existing) {
      const view: NegotiationView = {
        task_id: payload.task_id,
        context_id: payload.context_id ?? null,
        skill: payload.skill,
        participants: dedupe([
          payload.from_fips,
          ...(payload.to_fips != null ? [payload.to_fips] : []),
        ]),
        status: terminalStage(payload.stage)
          ? settlementStatus(payload.stage)
          : 'open',
        rounds: [payload],
        started_at: now,
        last_at: now,
      };
      this.negotiations.set(payload.task_id, view);
    } else {
      existing.rounds.push(payload);
      existing.last_at = now;
      if (payload.from_fips != null && !existing.participants.includes(payload.from_fips)) {
        existing.participants.push(payload.from_fips);
      }
      if (payload.to_fips != null && !existing.participants.includes(payload.to_fips)) {
        existing.participants.push(payload.to_fips);
      }
      if (terminalStage(payload.stage)) existing.status = settlementStatus(payload.stage);
    }
    this.trimNegotiations();
    this.emit('negotiation_round', payload);
  }

  ingestSwapExecuted(payload: SwapExecutedPayload): void {
    this.swaps.push(payload);
    if (this.swaps.length > SWAP_HISTORY_CAP) {
      this.swaps.splice(0, this.swaps.length - SWAP_HISTORY_CAP);
    }
    this.emit('swap_executed', payload);
  }

  ingestShockInjected(payload: ShockInjectedPayload): void {
    this.shocks.set(`${payload.state_fips}:${payload.event_type}:${payload.emitted_at}`, payload);
    this.gcShocks();
    this.emit('shock_injected', payload);
  }

  ingestReflection(payload: ReflectionPayload): void {
    this.reflections.set(payload.state_fips, payload);
    this.emit('reflection', payload);
  }

  private trimNegotiations(): void {
    if (this.negotiations.size <= NEGOTIATION_CAP) return;
    const cutoff = Date.now() - NEGOTIATION_TTL_MS;
    const entries = [...this.negotiations.entries()];
    entries.sort((a, b) => a[1].last_at.localeCompare(b[1].last_at));
    for (const [id, view] of entries) {
      if (this.negotiations.size <= NEGOTIATION_CAP) break;
      if (view.status !== 'open' || new Date(view.last_at).getTime() < cutoff) {
        this.negotiations.delete(id);
      } else {
        break;
      }
    }
  }

  private gcShocks(): void {
    const cutoff = Date.now() - SHOCK_TTL_MS;
    for (const [key, shock] of this.shocks) {
      if (new Date(shock.emitted_at).getTime() < cutoff) this.shocks.delete(key);
    }
  }

  updateMesh(observerPubkey: string, peers: string[]): void {
    this.mesh = {
      observerPubkey,
      peers,
      refreshedAt: new Date().toISOString(),
    };
    this.emit('peer_update', {
      observer_pubkey: observerPubkey,
      peer_count: peers.length,
      peers,
    });
  }

  hydrateFromMemory(): void {
    for (const state of this.states.values()) {
      const statePath = join(this.memoryRoot, state.abbr.toLowerCase(), 'state.json');
      if (!existsSync(statePath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as MemoryStateFile;
        state.composition = parsed.composition ?? state.composition;
        state.reserve_ratio =
          typeof parsed.reserveRatio === 'number' ? parsed.reserveRatio : state.reserve_ratio;
        state.total_value_usd =
          typeof parsed.totalValueUsd === 'number' ? parsed.totalValueUsd : state.total_value_usd;
        state.tick_count =
          typeof parsed.tickCount === 'number' ? parsed.tickCount : state.tick_count;
        state.health = deriveHealth(state.reserve_ratio, state.indicators.unemployment?.value);
        state.last_seen_at = state.last_seen_at ?? new Date().toISOString();
      } catch (err) {
        this.emit('system_event', {
          level: 'warn',
          message: `failed to read memory state for ${state.abbr}: ${String(err)}`,
        });
      }
    }
  }

  loadInfts(): void {
    if (!existsSync(this.manifestPath)) return;
    try {
      const manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as InftManifest;
      this.infts = manifest.entries ?? [];
      this.emit('inft_manifest_updated', {
        generated_at: manifest.generated_at,
        count: this.infts.length,
        mint_status: manifest.mint_status,
      });
    } catch (err) {
      this.emit('system_event', {
        level: 'warn',
        message: `failed to load iNFT manifest: ${String(err)}`,
      });
    }
  }

  snapshot(): MeshSnapshot {
    const now = new Date().toISOString();
    const states = [...this.states.values()].sort((a, b) => a.abbr.localeCompare(b.abbr));
    this.gcShocks();
    return {
      generated_at: now,
      mesh: {
        observer_pubkey: this.mesh.observerPubkey,
        peer_count: this.mesh.peers.length,
        peers: this.mesh.peers,
        last_refresh_at: this.mesh.refreshedAt,
      },
      metrics: {
        messages_seen: this.events.length,
        messages_per_minute: this.messagesPerMinute(),
        total_known_tvl_usd: states.reduce((sum, s) => sum + (s.total_value_usd ?? 0), 0),
        swaps_executed: this.swaps.length,
        negotiations_open: [...this.negotiations.values()].filter((n) => n.status === 'open')
          .length,
        shocks_active: this.shocks.size,
      },
      latest_fed_rate: this.latestFedRate,
      states,
      events: [...this.events].reverse().slice(0, 80),
      infts: this.infts,
      fed_rate_history: [...this.fedRateHistory],
      reflections: [...this.reflections.values()].sort((a, b) =>
        b.emitted_at.localeCompare(a.emitted_at),
      ),
      negotiations: [...this.negotiations.values()].sort((a, b) =>
        b.last_at.localeCompare(a.last_at),
      ),
      swaps: [...this.swaps].reverse(),
      shocks: [...this.shocks.values()].sort((a, b) => b.emitted_at.localeCompare(a.emitted_at)),
    };
  }

  fedRateHistorySnapshot(): FedRateHistoryEntry[] {
    return [...this.fedRateHistory];
  }

  negotiationSnapshot(): NegotiationView[] {
    return [...this.negotiations.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
  }

  negotiation(taskId: string): NegotiationView | null {
    return this.negotiations.get(taskId) ?? null;
  }

  swapHistorySnapshot(): SwapExecutedPayload[] {
    return [...this.swaps].reverse();
  }

  shockSnapshot(): ShockInjectedPayload[] {
    this.gcShocks();
    return [...this.shocks.values()].sort((a, b) => b.emitted_at.localeCompare(a.emitted_at));
  }

  reflectionsSnapshot(): ReflectionPayload[] {
    return [...this.reflections.values()].sort((a, b) =>
      b.emitted_at.localeCompare(a.emitted_at),
    );
  }

  eventsSince(limit = 100): ObserverEvent[] {
    return [...this.events].reverse().slice(0, Math.max(1, Math.min(limit, EVENT_CAP)));
  }

  queryTreasury(stateFips: number): QueryTreasuryResult {
    const state = this.ensureState(stateFips);
    const meta = lookupStateByFips(stateFips);
    return {
      state_fips: stateFips,
      state_abbr: meta?.abbr ?? `FIPS${stateFips}`,
      composition: state?.composition ?? [],
      reserve_ratio: state?.reserve_ratio ?? 0,
      total_value_usd: state?.total_value_usd ?? 0,
      timestamp: new Date().toISOString(),
    };
  }

  private ensureState(fips: number): StateDashboardView | undefined {
    const existing = this.states.get(fips);
    if (existing) return existing;
    const meta = lookupStateByFips(fips);
    if (!meta || meta.tier === 'federal') return undefined;
    const created: StateDashboardView = {
      fips: meta.fips,
      abbr: meta.abbr,
      name: meta.name,
      region: meta.region,
      tier: meta.tier,
      health: 'unknown',
      reserve_ratio: null,
      total_value_usd: null,
      composition: [],
      latest_indicator: null,
      indicators: {},
      tick_count: null,
      last_seen_at: null,
    };
    this.states.set(fips, created);
    return created;
  }

  private emit(kind: ObserverEventKind, payload: unknown): ObserverEvent {
    const event: ObserverEvent = {
      id: this.nextEventId++,
      kind,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    this.eventTimes.push(Date.now());
    if (this.eventTimes.length > STATE_MEMORY_CAP) {
      this.eventTimes.splice(0, this.eventTimes.length - STATE_MEMORY_CAP);
    }
    for (const fn of this.subscribers) fn(event);
    return event;
  }

  private messagesPerMinute(): number {
    const cutoff = Date.now() - 60_000;
    while (this.eventTimes[0] && this.eventTimes[0] < cutoff) this.eventTimes.shift();
    return this.eventTimes.length;
  }
}

export function defaultMemoryRoot(): string {
  return resolve(process.env.MEMORY_ROOT ?? resolve(process.cwd(), '../../memory'));
}

export function defaultManifestPath(): string {
  return resolve(
    process.env.INFT_MANIFEST_PATH ?? resolve(process.cwd(), '../../.data/inft-manifest.json'),
  );
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function terminalStage(stage: NegotiationRoundPayload['stage']): boolean {
  return (
    stage === 'accept' ||
    stage === 'reject' ||
    stage === 'settlement' ||
    stage === 'coalition_join' ||
    stage === 'coalition_decline'
  );
}

function settlementStatus(stage: NegotiationRoundPayload['stage']): NegotiationView['status'] {
  if (stage === 'reject' || stage === 'coalition_decline') return 'rejected';
  return 'settled';
}

function deriveHealth(
  reserveRatio: number | null,
  unemployment: number | undefined,
): StateDashboardView['health'] {
  if (reserveRatio == null && unemployment == null) return 'unknown';
  if (
    (reserveRatio != null && reserveRatio < 0.08) ||
    (unemployment != null && unemployment >= 7)
  ) {
    return 'red';
  }
  if (
    (reserveRatio != null && reserveRatio < 0.12) ||
    (unemployment != null && unemployment >= 5.5)
  ) {
    return 'amber';
  }
  return 'green';
}
