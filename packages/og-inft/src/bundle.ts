/**
 * Bundle = the canonical snapshot of an agent that gets encrypted, anchored
 * on 0G Storage, and committed to on the iNFT contract.
 *
 * The bundle is intentionally JSON so an off-chain decoder can reload an
 * agent's full mental state from the iNFT alone. Stable schema fields:
 *   - version
 *   - state_abbr / state_name / state_fips
 *   - persona — the LLM persona block
 *   - memory_state — full state.json content
 *   - recent_log — last N log entries (24 by default)
 *   - generated_at — ISO timestamp
 *   - generator — short string identifying who built it
 */

export interface AgentBundle {
  version: 1;
  state_abbr: string;
  state_name: string;
  state_fips: number;
  persona: unknown;
  memory_state: unknown;
  recent_log: unknown[];
  generated_at: string;
  generator: string;
}

export function bundleToBytes(bundle: AgentBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle));
}

export function bundleFromBytes(bytes: Uint8Array): AgentBundle {
  return JSON.parse(new TextDecoder().decode(bytes)) as AgentBundle;
}
