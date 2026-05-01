/**
 * Client-side state directory. The observer's /agents endpoint owns the
 * authoritative list at runtime; this file is a stable lookup so static
 * pieces of UI (shock ribbon, palette default) don't need a network round
 * trip just to map FIPS → abbr.
 */

export interface StateMeta {
  fips: number;
  abbr: string;
  name: string;
  region: 'northeast' | 'midwest' | 'south' | 'west' | 'territory' | 'federal';
  tier: 'deep' | 'observer' | 'federal';
}

const STATES: StateMeta[] = [
  { fips: 1, abbr: 'AL', name: 'Alabama', region: 'south', tier: 'observer' },
  { fips: 2, abbr: 'AK', name: 'Alaska', region: 'west', tier: 'deep' },
  { fips: 4, abbr: 'AZ', name: 'Arizona', region: 'west', tier: 'observer' },
  { fips: 5, abbr: 'AR', name: 'Arkansas', region: 'south', tier: 'observer' },
  { fips: 6, abbr: 'CA', name: 'California', region: 'west', tier: 'deep' },
  { fips: 8, abbr: 'CO', name: 'Colorado', region: 'west', tier: 'observer' },
  { fips: 9, abbr: 'CT', name: 'Connecticut', region: 'northeast', tier: 'observer' },
  { fips: 10, abbr: 'DE', name: 'Delaware', region: 'northeast', tier: 'observer' },
  { fips: 12, abbr: 'FL', name: 'Florida', region: 'south', tier: 'deep' },
  { fips: 13, abbr: 'GA', name: 'Georgia', region: 'south', tier: 'observer' },
  { fips: 15, abbr: 'HI', name: 'Hawaii', region: 'west', tier: 'observer' },
  { fips: 16, abbr: 'ID', name: 'Idaho', region: 'west', tier: 'observer' },
  { fips: 17, abbr: 'IL', name: 'Illinois', region: 'midwest', tier: 'deep' },
  { fips: 18, abbr: 'IN', name: 'Indiana', region: 'midwest', tier: 'observer' },
  { fips: 19, abbr: 'IA', name: 'Iowa', region: 'midwest', tier: 'observer' },
  { fips: 20, abbr: 'KS', name: 'Kansas', region: 'midwest', tier: 'observer' },
  { fips: 21, abbr: 'KY', name: 'Kentucky', region: 'south', tier: 'observer' },
  { fips: 22, abbr: 'LA', name: 'Louisiana', region: 'south', tier: 'observer' },
  { fips: 23, abbr: 'ME', name: 'Maine', region: 'northeast', tier: 'observer' },
  { fips: 24, abbr: 'MD', name: 'Maryland', region: 'northeast', tier: 'observer' },
  { fips: 25, abbr: 'MA', name: 'Massachusetts', region: 'northeast', tier: 'deep' },
  { fips: 26, abbr: 'MI', name: 'Michigan', region: 'midwest', tier: 'observer' },
  { fips: 27, abbr: 'MN', name: 'Minnesota', region: 'midwest', tier: 'observer' },
  { fips: 28, abbr: 'MS', name: 'Mississippi', region: 'south', tier: 'observer' },
  { fips: 29, abbr: 'MO', name: 'Missouri', region: 'midwest', tier: 'observer' },
  { fips: 30, abbr: 'MT', name: 'Montana', region: 'west', tier: 'observer' },
  { fips: 31, abbr: 'NE', name: 'Nebraska', region: 'midwest', tier: 'observer' },
  { fips: 32, abbr: 'NV', name: 'Nevada', region: 'west', tier: 'observer' },
  { fips: 33, abbr: 'NH', name: 'New Hampshire', region: 'northeast', tier: 'observer' },
  { fips: 34, abbr: 'NJ', name: 'New Jersey', region: 'northeast', tier: 'observer' },
  { fips: 35, abbr: 'NM', name: 'New Mexico', region: 'west', tier: 'observer' },
  { fips: 36, abbr: 'NY', name: 'New York', region: 'northeast', tier: 'deep' },
  { fips: 37, abbr: 'NC', name: 'North Carolina', region: 'south', tier: 'observer' },
  { fips: 38, abbr: 'ND', name: 'North Dakota', region: 'midwest', tier: 'observer' },
  { fips: 39, abbr: 'OH', name: 'Ohio', region: 'midwest', tier: 'observer' },
  { fips: 40, abbr: 'OK', name: 'Oklahoma', region: 'south', tier: 'observer' },
  { fips: 41, abbr: 'OR', name: 'Oregon', region: 'west', tier: 'observer' },
  { fips: 42, abbr: 'PA', name: 'Pennsylvania', region: 'northeast', tier: 'observer' },
  { fips: 44, abbr: 'RI', name: 'Rhode Island', region: 'northeast', tier: 'observer' },
  { fips: 45, abbr: 'SC', name: 'South Carolina', region: 'south', tier: 'observer' },
  { fips: 46, abbr: 'SD', name: 'South Dakota', region: 'midwest', tier: 'observer' },
  { fips: 47, abbr: 'TN', name: 'Tennessee', region: 'south', tier: 'observer' },
  { fips: 48, abbr: 'TX', name: 'Texas', region: 'south', tier: 'deep' },
  { fips: 49, abbr: 'UT', name: 'Utah', region: 'west', tier: 'observer' },
  { fips: 50, abbr: 'VT', name: 'Vermont', region: 'northeast', tier: 'observer' },
  { fips: 51, abbr: 'VA', name: 'Virginia', region: 'south', tier: 'observer' },
  { fips: 53, abbr: 'WA', name: 'Washington', region: 'west', tier: 'deep' },
  { fips: 54, abbr: 'WV', name: 'West Virginia', region: 'south', tier: 'observer' },
  { fips: 55, abbr: 'WI', name: 'Wisconsin', region: 'midwest', tier: 'observer' },
  { fips: 56, abbr: 'WY', name: 'Wyoming', region: 'west', tier: 'observer' },
];

const BY_FIPS = new Map(STATES.map((s) => [s.fips, s]));
const BY_ABBR = new Map(STATES.map((s) => [s.abbr, s]));

export function lookupStateByFips(fips: number | null | undefined): StateMeta | undefined {
  if (fips == null) return undefined;
  return BY_FIPS.get(fips);
}

export function lookupStateByAbbr(abbr: string | null | undefined): StateMeta | undefined {
  if (!abbr) return undefined;
  return BY_ABBR.get(abbr.toUpperCase());
}

export const ALL_STATES: readonly StateMeta[] = STATES;
