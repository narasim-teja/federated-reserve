import type { InftEntry, StateView } from './types';

const SEED_DEEP: Array<[string, string, StateView['region']]> = [
  ['AK', 'Alaska', 'west'],
  ['CA', 'California', 'west'],
  ['FL', 'Florida', 'south'],
  ['IL', 'Illinois', 'midwest'],
  ['MA', 'Massachusetts', 'northeast'],
  ['NY', 'New York', 'northeast'],
  ['TX', 'Texas', 'south'],
  ['WA', 'Washington', 'west'],
];

export const FALLBACK_STATES: StateView[] = SEED_DEEP.map(([abbr, name, region], i) => ({
  fips: i + 1,
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
  last_seen_at: null,
}));

export const FALLBACK_INFTS: InftEntry[] = FALLBACK_STATES.map((s) => ({
  state_abbr: s.abbr,
  state_name: s.name,
  owner_address: '',
  token_id: null,
  mint_status: 'pending_0g',
  metadata_uri: 'pending manifest',
  metadata_hash: 'pending',
  persona_tagline: `${s.name} agent persona will hydrate from the observer manifest.`,
  contract: { chain: '0g-testnet', address: '', explorer_url: '' },
}));
