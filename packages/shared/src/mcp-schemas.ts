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

// FIPS-like agent identity shape. Real states top out at PR=72, and Phase 4
// adds synthetic FED/TRS identities at 100/101. Codes are validated against
// the canonical set in `states.ts` where semantics matter.
export const fipsSchema = z.number().int().min(1).max(101);

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
  // BLS LAUS state-level
  'employment_count',
  'labor_force',
  // BEA Regional
  'gdp_quarterly',
  'gdp_annual',
  'personal_income_total',
  // Census ACS 5-year baselines
  'population',
  'median_household_income',
  'poverty_rate',
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

// ---------- announce_fed_rate (Phase 4 — Federal Reserve broadcast) ----------

export const announceFedRateInputSchema = z.object({
  rate_bps: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .describe('New federal funds rate in basis points (e.g. 525 = 5.25%).'),
  effective: z.string().describe('ISO-8601 effective timestamp.'),
  rationale: z.string().min(1).max(500),
});
export type AnnounceFedRateInput = z.infer<typeof announceFedRateInputSchema>;

export const announceFedRateResultSchema = z.object({
  acknowledged: z.literal(true),
  receiver_fips: z.number().int(),
  received_at: z.string(),
});
export type AnnounceFedRateResult = z.infer<typeof announceFedRateResultSchema>;

// ---------- issue_federal_transfer (Phase 4 — Treasury action tool) ----------

export const issueFederalTransferInputSchema = z.object({
  recipient_fips: fipsSchema.describe('Recipient state FIPS code.'),
  amount_usd: z.number().positive().describe('Transfer amount in whole USD.'),
  reason: z.string().min(1).max(500),
});
export type IssueFederalTransferInput = z.infer<typeof issueFederalTransferInputSchema>;

export const issueFederalTransferResultSchema = z.object({
  approved: z.boolean(),
  recipient_fips: z.number().int(),
  amount_usd: z.number(),
  /** Hex tx hash of the USDC.transfer if approved, else empty. */
  tx_hash: z.string(),
  /** Block number; empty when not approved. */
  block_number: z.string(),
  /** Treasury's reasoner-driven justification. */
  rationale: z.string(),
});
export type IssueFederalTransferResult = z.infer<typeof issueFederalTransferResultSchema>;

// ---------- MCP tool name registry ------------------------------------------

export const MCP_TOOLS = {
  QUERY_TREASURY: 'query_treasury',
  SHARE_ECONOMIC_INDICATOR: 'share_economic_indicator',
  SHARE_TOPOLOGY: 'share_topology',
  ANNOUNCE_FED_RATE: 'announce_fed_rate',
  ISSUE_FEDERAL_TRANSFER: 'issue_federal_transfer',
} as const;

export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

/** Service name agents register with the local MCP Router under. */
export const TREASURER_SERVICE_NAME = 'treasurer';
