/**
 * Agent in-memory state — the live working copy.
 *
 * Persistence:
 *   - On startup, the agent loads any prior state from `AgentMemory` (KV
 *     read). If none exists (cold start), `makeInitialState` seeds defaults.
 *   - On meaningful changes (treasury rebalance, indicator update), the
 *     agent calls `memory.saveState(state)` to flush.
 *
 * Append-only history (decisions, broadcasts, reflection notes) lives in
 * `memory.appendLog(...)`, not on this object.
 */

import type { ShareEconomicIndicatorInput, StateSnapshot } from '@federated-reserve/shared';
import type { ChainBalances } from './chain-reader.ts';
import type { OgStatus } from './og-reader.ts';

export interface TreasuryAsset {
  asset: string;
  balance: string;
}

export interface FedRateRecord {
  rateBps: number;
  effective: string;
  rationale: string;
  receivedAt: string;
}

export interface AgentState {
  composition: TreasuryAsset[];
  reserveRatio: number;
  totalValueUsd: number;
  /** Indicators received from peers, in arrival order. Bounded — see `pushReceivedIndicator`. */
  receivedIndicators: Array<ShareEconomicIndicatorInput & { receivedAt: string }>;
  /** Most recent data-plane snapshot we read for our own state, if any. */
  ownSnapshot?: StateSnapshot;
  /** Tick counter — survives restarts via memory. */
  tickCount: number;
  /** Phase 4 — most recent fed rate announcements received from FED. Bounded. */
  receivedFedRates?: FedRateRecord[];
  /**
   * Cost-optimization hash. Set after each successful reflection LLM call to
   * a digest of the inputs (recent log + tick + reserve). On the next
   * reflection cadence, if the hash is identical we skip the LLM round-trip
   * and emit a "unchanged" stub instead — most idle ticks produce no new
   * information worth re-reflecting on.
   */
  lastReflectionHash?: string;
  /** Hex address this agent transacts from (Unichain Sepolia + 0G Galileo). */
  walletAddress?: string;
  /** Last successful Unichain Sepolia balance snapshot. */
  chainBalances?: ChainBalances;
  /** Last successful 0G Galileo status read. */
  ogStatus?: OgStatus;
  /** Tick at which the autonomous rebalance policy last fired a swap. */
  lastAutoSwapTick?: number;
  /**
   * Most recent successful 0G iNFT anchor — populated by the og-anchor
   * pipeline after each `INFT7857.updateMetadata` call. Surfaces the *live*
   * blob/submission identifiers so the dashboard can link to the freshest
   * anchor instead of the original mint-time rootHash.
   */
  lastAnchor?: {
    rootHash: string;
    /** Storage sequence number — what /submission/<txSeq> resolves on storagescan. */
    txSeq?: string;
    /** 0G Storage submission tx hash (separate from `updateMetadataTx`). */
    storageTx: string;
    /** updateMetadata() tx on the iNFT contract. */
    updateMetadataTx: string;
    /** Anchor reason ("cold-start", "decision", "heartbeat-7-ticks", etc.). */
    reason: string;
    /** Tick that produced this anchor. */
    tickCount: number;
    /** ISO-8601 timestamp. */
    at: string;
  };
}

const RECEIVED_INDICATORS_CAP = 200;

export function makeInitialState(stateFips: number): AgentState {
  // Cold-start defaults. Real numbers replace these on the first
  // ChainReader.refresh() that succeeds (see tick.ts). We keep harmless
  // placeholders so the dashboard renders something on a brand-new mesh
  // before the first RPC roundtrip lands.
  return {
    composition: [
      { asset: 'USDC', balance: '0' },
      { asset: 'STATE_TOKEN', balance: '0' },
    ],
    reserveRatio: 0,
    totalValueUsd: 0,
    receivedIndicators: [],
    tickCount: 0,
    // FIPS read so the cold-start file has at least an opinion about region;
    // this gets immediately overwritten by the first chain refresh.
    lastAutoSwapTick: -stateFips, // negative sentinel; never matches a real tick
  };
}

/**
 * Project a `ChainBalances` reading onto the persisted treasury fields the
 * dashboard renders (`composition`, `totalValueUsd`, `reserveRatio`).
 *
 * Convention:
 *   - composition[0] is always USDC (raw 6-decimal base units, like before)
 *   - composition[1] is the agent's own state token (raw 18-decimal)
 *   - subsequent entries are bond holdings the agent owns
 *   - totalValueUsd = USDC + state-token-at-par + sum(bond notional)
 *   - reserveRatio  = USDC / totalValueUsd  (what fraction of holdings is liquid stable)
 */
export function applyChainBalances(state: AgentState, b: ChainBalances): void {
  const next: TreasuryAsset[] = [
    { asset: 'USDC', balance: b.usdcBalanceRaw },
  ];
  if (b.stateToken) {
    next.push({ asset: b.stateToken.symbol, balance: b.stateToken.balanceRaw });
  }
  for (const bond of b.bonds) {
    next.push({ asset: bond.symbol, balance: bond.balanceRaw });
  }
  state.composition = next;
  state.totalValueUsd = b.totalNotionalUsd;
  state.reserveRatio = b.liquidReserveRatio;
  state.chainBalances = b;
  state.walletAddress = b.walletAddress;
}

export function applyOgStatus(state: AgentState, og: OgStatus): void {
  state.ogStatus = og;
  // Keep walletAddress in sync — same wallet is used on both chains.
  if (!state.walletAddress) state.walletAddress = og.walletAddress;
}

/** Push with cap so memory doesn't grow unbounded across many ticks. */
export function pushReceivedIndicator(
  state: AgentState,
  entry: ShareEconomicIndicatorInput & { receivedAt: string },
): void {
  state.receivedIndicators.push(entry);
  if (state.receivedIndicators.length > RECEIVED_INDICATORS_CAP) {
    state.receivedIndicators.splice(0, state.receivedIndicators.length - RECEIVED_INDICATORS_CAP);
  }
}

const FED_RATE_CAP = 32;

export function pushReceivedFedRate(state: AgentState, record: FedRateRecord): void {
  if (!state.receivedFedRates) state.receivedFedRates = [];
  state.receivedFedRates.push(record);
  if (state.receivedFedRates.length > FED_RATE_CAP) {
    state.receivedFedRates.splice(0, state.receivedFedRates.length - FED_RATE_CAP);
  }
}
