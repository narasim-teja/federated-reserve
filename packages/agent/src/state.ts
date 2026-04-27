/**
 * In-memory agent state. Phase 1 only — Phase 2 replaces this with 0G Storage.
 *
 * Tracks:
 *   - the (stub) treasury composition served via `query_treasury`
 *   - the indicators received from peers via `share_economic_indicator`
 *     (each agent logs received indicators so the broadcast test can verify
 *     fan-out across peers)
 */

import type { ShareEconomicIndicatorInput } from '@federated-reserve/shared';

export interface TreasuryAsset {
  asset: string;
  balance: string;
}

export interface AgentState {
  composition: TreasuryAsset[];
  reserveRatio: number;
  totalValueUsd: number;
  /** Indicators received from peers, in arrival order. */
  receivedIndicators: Array<ShareEconomicIndicatorInput & { receivedAt: string }>;
}

export function makeInitialState(stateFips: number): AgentState {
  // Phase 1 stub data — same shape spike-01 returned, FIPS-tagged.
  return {
    composition: [
      { asset: 'USDC', balance: '1000000000000' }, // 1M USDC (6 decimals)
      { asset: 'TBILL', balance: '500000000000' },
      { asset: 'EQUITY', balance: '250000000000' },
    ],
    reserveRatio: 0.124,
    totalValueUsd: 1_750_000 + stateFips * 1_000, // tiny per-state variation for visibility
    receivedIndicators: [],
  };
}
