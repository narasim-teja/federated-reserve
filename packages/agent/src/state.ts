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

export interface TreasuryAsset {
  asset: string;
  balance: string;
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
}

const RECEIVED_INDICATORS_CAP = 200;

export function makeInitialState(stateFips: number): AgentState {
  // Phase 2 stub treasury — Phase 3 swaps these for real onchain balances.
  return {
    composition: [
      { asset: 'USDC', balance: '1000000000000' },
      { asset: 'TBILL', balance: '500000000000' },
      { asset: 'EQUITY', balance: '250000000000' },
    ],
    reserveRatio: 0.124,
    totalValueUsd: 1_750_000 + stateFips * 1_000,
    receivedIndicators: [],
    tickCount: 0,
  };
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
