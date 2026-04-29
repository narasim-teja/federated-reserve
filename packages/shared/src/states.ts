/**
 * US state (and territory) metadata.
 *
 * `fips` doubles as the BIP-44 wallet derivation index per TECHNICAL.md
 * (m/44'/60'/0'/0/{fips}). Federal/Treasury use indices 100/101.
 *
 * `tier` selects model + initiative scope: 'deep' agents run on Claude Opus
 * 4.7 with full skill set and initiate strategies; 'observer' agents run on
 * Claude Haiku 4.5, respond to incoming proposals but don't initiate
 * coalitions. Phase 2 wires this in; Phase 1 just carries the field.
 */

/**
 * Agent tier:
 *   - 'deep'     — hand-tuned persona, full skill set, initiates strategies (Phase 2-3 8 states)
 *   - 'observer' — region-fallback persona, responds to proposals, limited init scope (Phase 2 42 states)
 *   - 'federal'  — synthetic non-state agent (Federal Reserve, Treasury). Phase 4. No FRED snapshots.
 */
export type StateTier = 'deep' | 'observer' | 'federal';

/** Phase 4 introduces 'federal' for the Fed + Treasury synthetic agents. */
export type CensusRegion = 'northeast' | 'midwest' | 'south' | 'west' | 'territory' | 'federal';

export interface StateInfo {
  fips: number;
  abbr: string;
  name: string;
  region: CensusRegion;
  tier: StateTier;
}

const DEEP_ABBRS = new Set(['MA', 'CA', 'TX', 'NY', 'FL', 'IL', 'WA', 'AK']);

const RAW: Array<Omit<StateInfo, 'tier'>> = [
  { fips: 1, abbr: 'AL', name: 'Alabama', region: 'south' },
  { fips: 2, abbr: 'AK', name: 'Alaska', region: 'west' },
  { fips: 4, abbr: 'AZ', name: 'Arizona', region: 'west' },
  { fips: 5, abbr: 'AR', name: 'Arkansas', region: 'south' },
  { fips: 6, abbr: 'CA', name: 'California', region: 'west' },
  { fips: 8, abbr: 'CO', name: 'Colorado', region: 'west' },
  { fips: 9, abbr: 'CT', name: 'Connecticut', region: 'northeast' },
  { fips: 10, abbr: 'DE', name: 'Delaware', region: 'south' },
  { fips: 11, abbr: 'DC', name: 'District of Columbia', region: 'south' },
  { fips: 12, abbr: 'FL', name: 'Florida', region: 'south' },
  { fips: 13, abbr: 'GA', name: 'Georgia', region: 'south' },
  { fips: 15, abbr: 'HI', name: 'Hawaii', region: 'west' },
  { fips: 16, abbr: 'ID', name: 'Idaho', region: 'west' },
  { fips: 17, abbr: 'IL', name: 'Illinois', region: 'midwest' },
  { fips: 18, abbr: 'IN', name: 'Indiana', region: 'midwest' },
  { fips: 19, abbr: 'IA', name: 'Iowa', region: 'midwest' },
  { fips: 20, abbr: 'KS', name: 'Kansas', region: 'midwest' },
  { fips: 21, abbr: 'KY', name: 'Kentucky', region: 'south' },
  { fips: 22, abbr: 'LA', name: 'Louisiana', region: 'south' },
  { fips: 23, abbr: 'ME', name: 'Maine', region: 'northeast' },
  { fips: 24, abbr: 'MD', name: 'Maryland', region: 'south' },
  { fips: 25, abbr: 'MA', name: 'Massachusetts', region: 'northeast' },
  { fips: 26, abbr: 'MI', name: 'Michigan', region: 'midwest' },
  { fips: 27, abbr: 'MN', name: 'Minnesota', region: 'midwest' },
  { fips: 28, abbr: 'MS', name: 'Mississippi', region: 'south' },
  { fips: 29, abbr: 'MO', name: 'Missouri', region: 'midwest' },
  { fips: 30, abbr: 'MT', name: 'Montana', region: 'west' },
  { fips: 31, abbr: 'NE', name: 'Nebraska', region: 'midwest' },
  { fips: 32, abbr: 'NV', name: 'Nevada', region: 'west' },
  { fips: 33, abbr: 'NH', name: 'New Hampshire', region: 'northeast' },
  { fips: 34, abbr: 'NJ', name: 'New Jersey', region: 'northeast' },
  { fips: 35, abbr: 'NM', name: 'New Mexico', region: 'west' },
  { fips: 36, abbr: 'NY', name: 'New York', region: 'northeast' },
  { fips: 37, abbr: 'NC', name: 'North Carolina', region: 'south' },
  { fips: 38, abbr: 'ND', name: 'North Dakota', region: 'midwest' },
  { fips: 39, abbr: 'OH', name: 'Ohio', region: 'midwest' },
  { fips: 40, abbr: 'OK', name: 'Oklahoma', region: 'south' },
  { fips: 41, abbr: 'OR', name: 'Oregon', region: 'west' },
  { fips: 42, abbr: 'PA', name: 'Pennsylvania', region: 'northeast' },
  { fips: 44, abbr: 'RI', name: 'Rhode Island', region: 'northeast' },
  { fips: 45, abbr: 'SC', name: 'South Carolina', region: 'south' },
  { fips: 46, abbr: 'SD', name: 'South Dakota', region: 'midwest' },
  { fips: 47, abbr: 'TN', name: 'Tennessee', region: 'south' },
  { fips: 48, abbr: 'TX', name: 'Texas', region: 'south' },
  { fips: 49, abbr: 'UT', name: 'Utah', region: 'west' },
  { fips: 50, abbr: 'VT', name: 'Vermont', region: 'northeast' },
  { fips: 51, abbr: 'VA', name: 'Virginia', region: 'south' },
  { fips: 53, abbr: 'WA', name: 'Washington', region: 'west' },
  { fips: 54, abbr: 'WV', name: 'West Virginia', region: 'south' },
  { fips: 55, abbr: 'WI', name: 'Wisconsin', region: 'midwest' },
  { fips: 56, abbr: 'WY', name: 'Wyoming', region: 'west' },
  { fips: 72, abbr: 'PR', name: 'Puerto Rico', region: 'territory' },
];

/**
 * Phase 4 — synthetic federal-tier agents. They share the same agent
 * runtime as states but skip data-plane snapshots (no per-state FRED
 * series for FIPS 100/101) and expose their own MCP tools (announce
 * fed rate, federal transfer).
 */
const FEDERAL_AGENTS: ReadonlyArray<StateInfo> = [
  { fips: 100, abbr: 'FED', name: 'Federal Reserve', region: 'federal', tier: 'federal' },
  { fips: 101, abbr: 'TRS', name: 'US Treasury', region: 'federal', tier: 'federal' },
];

export const STATES: readonly StateInfo[] = [
  ...RAW.map<StateInfo>((s) => ({
    ...s,
    tier: DEEP_ABBRS.has(s.abbr) ? 'deep' : 'observer',
  })),
  ...FEDERAL_AGENTS,
];

export const STATES_BY_FIPS: Readonly<Record<number, StateInfo>> = Object.freeze(
  Object.fromEntries(STATES.map((s) => [s.fips, s])),
);

export const STATES_BY_ABBR: Readonly<Record<string, StateInfo>> = Object.freeze(
  Object.fromEntries(STATES.map((s) => [s.abbr, s])),
);

export function lookupStateByFips(fips: number): StateInfo | undefined {
  return STATES_BY_FIPS[fips];
}

export function lookupStateByAbbr(abbr: string): StateInfo | undefined {
  return STATES_BY_ABBR[abbr.toUpperCase()];
}

/** Special non-state agent identities. */
export const FEDERAL_RESERVE_WALLET_INDEX = 100;
export const TREASURY_WALLET_INDEX = 101;
