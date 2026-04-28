/**
 * Zod schemas for the MCP tools each state-agent exposes.
 *
 * Phase 1 ships the two tools we need to gate the mesh — `query_treasury`
 * (single-shot read) and `share_economic_indicator` (broadcast tool, fanned
 * out at the application layer since AXL does not expose a native pubsub
 * primitive). The rest of the tool surface in TECHNICAL.md (announce_fed_rate,
 * shock_event, post_credit_rating, announce_bond_auction, execute_swap,
 * issue_bond, ...) lands in Phases 2-4 alongside the logic that produces them.
 */

import { z } from 'zod';

// FIPS code shape — codes are not contiguous (gaps at 3, 7, 14, 43, 52, etc.)
// so we validate against the canonical set in `states.ts` at runtime.
export const fipsSchema = z.number().int().min(1).max(78);

// ---------- query_treasury ---------------------------------------------------

export const queryTreasuryInputSchema = z.object({
  state_fips: fipsSchema.describe('US state FIPS code, e.g. 25 for Massachusetts'),
});
export type QueryTreasuryInput = z.infer<typeof queryTreasuryInputSchema>;

export const treasuryAssetSchema = z.object({
  asset: z.string(),
  balance: z.string(), // bigint as string for JSON-RPC safety
});
export type TreasuryAsset = z.infer<typeof treasuryAssetSchema>;

export const queryTreasuryResultSchema = z.object({
  state_fips: z.number().int(),
  state_abbr: z.string(),
  composition: z.array(treasuryAssetSchema),
  reserve_ratio: z.number(),
  total_value_usd: z.number(),
  timestamp: z.string(),
});
export type QueryTreasuryResult = z.infer<typeof queryTreasuryResultSchema>;

// ---------- share_economic_indicator ----------------------------------------

export const economicIndicatorKindSchema = z.enum([
  'unemployment',
  'gdp_growth',
  'tax_revenue',
  'reserve_ratio',
  'personal_income',
  'cpi',
]);
export type EconomicIndicatorKind = z.infer<typeof economicIndicatorKindSchema>;

export const shareEconomicIndicatorInputSchema = z.object({
  state_fips: fipsSchema.describe('Originating state FIPS code'),
  indicator: economicIndicatorKindSchema,
  value: z.number(),
  timestamp: z.string().describe('ISO-8601 timestamp'),
  source: z.string().describe('FRED series ID, BLS table, etc.'),
});
export type ShareEconomicIndicatorInput = z.infer<typeof shareEconomicIndicatorInputSchema>;

export const shareEconomicIndicatorResultSchema = z.object({
  acknowledged: z.literal(true),
  receiver_fips: z.number().int(),
  received_at: z.string(),
});
export type ShareEconomicIndicatorResult = z.infer<typeof shareEconomicIndicatorResultSchema>;

// ---------- share_topology ---------------------------------------------------

/**
 * Returns this agent's current view of the mesh — the set of peer pubkeys
 * it has discovered so far, including indirect peers learned via gossip.
 *
 * Why this exists: AXL's `/topology.tree` field propagates eventually-
 * consistently and under-reports for non-hub nodes (a leaf may not see its
 * sibling for several minutes even though routing works fine). So agents
 * gossip their views over MCP. After 1-2 refresh rounds, every agent
 * converges on the full mesh.
 */
export const shareTopologyInputSchema = z
  .object({
    // Empty by design — caller wants whatever this peer currently knows.
  })
  .strict();
export type ShareTopologyInput = z.infer<typeof shareTopologyInputSchema>;

export const shareTopologyResultSchema = z.object({
  responder_pubkey: z.string(),
  /** Hex-encoded ed25519 public keys, excluding the responder's own. */
  peers: z.array(z.string()),
  /** ISO-8601 timestamp of when this view was last refreshed. */
  refreshed_at: z.string(),
});
export type ShareTopologyResult = z.infer<typeof shareTopologyResultSchema>;

// ---------- MCP tool name registry ------------------------------------------

export const MCP_TOOLS = {
  QUERY_TREASURY: 'query_treasury',
  SHARE_ECONOMIC_INDICATOR: 'share_economic_indicator',
  SHARE_TOPOLOGY: 'share_topology',
} as const;

export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

/** Service name agents register with the local MCP Router under. */
export const TREASURER_SERVICE_NAME = 'treasurer';
