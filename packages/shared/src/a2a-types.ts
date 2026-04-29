/**
 * A2A skill payload shapes for the federated mesh.
 *
 * Phase 1 implements `negotiate-bilateral-swap` end-to-end (multi-turn task
 * lifecycle). The other skills declared in TECHNICAL.md
 * (participate-in-coalition, bond-auction, request-emergency-aid,
 * coordinate-shock-response) ship in later phases.
 */

import { z } from 'zod';
import { fipsSchema } from './mcp-schemas.ts';

// ---------- skill ids -------------------------------------------------------

export const A2A_SKILLS = {
  NEGOTIATE_BILATERAL_SWAP: 'negotiate-bilateral-swap',
  PARTICIPATE_IN_COALITION: 'participate-in-coalition',
  BOND_AUCTION: 'bond-auction',
  REQUEST_EMERGENCY_AID: 'request-emergency-aid',
  COORDINATE_SHOCK_RESPONSE: 'coordinate-shock-response',
} as const;

export type A2ASkillId = (typeof A2A_SKILLS)[keyof typeof A2A_SKILLS];

// ---------- shared atoms ----------------------------------------------------

export const assetAmountSchema = z.object({
  asset: z.string(),
  amount: z.string(), // bigint as string
});
export type AssetAmount = z.infer<typeof assetAmountSchema>;

// ---------- negotiate-bilateral-swap ----------------------------------------

/**
 * Initial proposal sent in the first message of the task.
 *
 * Lifecycle:
 *   role=user (initiator):     proposal           → state Working
 *   role=agent (counterparty): counter            → state InputRequired
 *   role=user (initiator):     accept | counter   → state Working/Completed
 *   role=agent (counterparty): final accept       → state Completed
 *
 * Each message's `data` part discriminates on `kind`.
 */
export const swapProposalSchema = z.object({
  kind: z.literal('proposal'),
  initiator_fips: fipsSchema,
  give: assetAmountSchema,
  receive: assetAmountSchema,
  rationale: z.string().min(1).max(500),
});
export type SwapProposal = z.infer<typeof swapProposalSchema>;

export const swapCounterSchema = z.object({
  kind: z.literal('counter'),
  responder_fips: fipsSchema,
  give: assetAmountSchema,
  receive: assetAmountSchema,
  rationale: z.string().min(1).max(500),
});
export type SwapCounter = z.infer<typeof swapCounterSchema>;

export const swapAcceptSchema = z.object({
  kind: z.literal('accept'),
  by_fips: fipsSchema,
  agreed_give: assetAmountSchema,
  agreed_receive: assetAmountSchema,
});
export type SwapAccept = z.infer<typeof swapAcceptSchema>;

export const swapRejectSchema = z.object({
  kind: z.literal('reject'),
  by_fips: fipsSchema,
  reason: z.string(),
});
export type SwapReject = z.infer<typeof swapRejectSchema>;

export const negotiateSwapMessageSchema = z.discriminatedUnion('kind', [
  swapProposalSchema,
  swapCounterSchema,
  swapAcceptSchema,
  swapRejectSchema,
]);
export type NegotiateSwapMessage = z.infer<typeof negotiateSwapMessageSchema>;

/**
 * Per-side execution leg. Phase 3 fires two of these per bilateral swap:
 * the responder's leg ships inside the Completed settlement payload, the
 * initiator's leg fires after the initiator observes Completed in their
 * own process and is recorded in their local memory log.
 */
export const swapTxLegSchema = z.object({
  fips: fipsSchema,
  swapper_address: z.string(),
  token_in_symbol: z.string(),
  token_in_address: z.string(),
  token_out_symbol: z.string(),
  token_out_address: z.string(),
  amount_in: z.string(),
  expected_amount_out: z.string(),
  tx_hash: z.string(),
  block_number: z.string(),
  status: z.enum(['success', 'reverted']),
  quote_request_id: z.string(),
  swap_request_id: z.string(),
});
export type SwapTxLeg = z.infer<typeof swapTxLegSchema>;

/** Final settlement record emitted on Completed terminal state. */
export const swapSettlementSchema = z.object({
  kind: z.literal('settlement'),
  initiator_fips: fipsSchema,
  responder_fips: fipsSchema,
  agreed_give: assetAmountSchema,
  agreed_receive: assetAmountSchema,
  rounds: z.number().int().min(1),
  /**
   * Two-leg execution record. Each side fires its own Uniswap Trading API
   * swap; the responder's leg is populated synchronously inside the
   * Completed handler, while the initiator's leg is appended in the
   * initiator's process and surfaces in their memory log only.
   */
  legs: z.object({
    initiator: swapTxLegSchema.nullable(),
    responder: swapTxLegSchema.nullable(),
  }),
  /**
   * Legacy single-tx-hash field for Phase 1/2 callers. Populated with the
   * responder's tx hash if present, else the initiator's, else null.
   */
  tx_hash: z.string().nullable(),
  settled_at: z.string(),
});
export type SwapSettlement = z.infer<typeof swapSettlementSchema>;

// ---------- skill envelope (skills other than negotiate-bilateral-swap) -----
//
// Phase 2 adds four skill payload shapes. Each is wrapped in a top-level
// envelope so the executor can dispatch by `skill` before parsing the
// payload. negotiate-bilateral-swap retains its Phase-1 schema (no envelope)
// for backward compatibility with the existing gate test.

export const COALITION_TAGS = [
  'northeast',
  'midwest',
  'south',
  'west',
  'tech-correlated',
  'finance-correlated',
  'energy-correlated',
  'climate-exposed',
  'hurricane-exposed',
  'gulf-disaster-pool',
  'pension-stressed',
  'sovereign-wealth-style',
] as const;
export const coalitionTagSchema = z.enum(COALITION_TAGS);
export type CoalitionTag = z.infer<typeof coalitionTagSchema>;

// participate-in-coalition: initiator invites peers to join a coalition by tag
export const coalitionInviteSchema = z.object({
  skill: z.literal('participate-in-coalition'),
  initiator_fips: fipsSchema,
  coalition_tag: coalitionTagSchema,
  topic: z
    .string()
    .min(1)
    .max(200)
    .describe('Free-text coalition purpose, e.g. "shared-aid-pool-Q3-2026"'),
  proposed_contribution_usd: z.number().nonnegative(),
});
export type CoalitionInvite = z.infer<typeof coalitionInviteSchema>;

export const coalitionResponseSchema = z.object({
  skill: z.literal('participate-in-coalition'),
  kind: z.enum(['joined', 'declined']),
  responder_fips: fipsSchema,
  contribution_usd: z.number().nonnegative(),
  rationale: z.string().min(1).max(500),
});
export type CoalitionResponse = z.infer<typeof coalitionResponseSchema>;

// bond-auction: issuer announces, peer bids
export const bondBidSchema = z.object({
  skill: z.literal('bond-auction'),
  issuer_fips: fipsSchema,
  bidder_fips: fipsSchema,
  bond_id: z.string().min(1).max(80),
  principal_usd: z.number().positive(),
  bid_yield_bps: z.number().int().min(0).max(50_000),
  rationale: z.string().min(1).max(500),
});
export type BondBid = z.infer<typeof bondBidSchema>;

export const bondAwardSchema = z.object({
  skill: z.literal('bond-auction'),
  kind: z.enum(['awarded', 'rejected']),
  bond_id: z.string(),
  to_fips: fipsSchema,
  yield_bps: z.number().int(),
  rationale: z.string().min(1).max(500),
  /**
   * Phase 3 settlement (issuer side). Populated when the issuer mints the
   * BondToken to the awarded bidder. Bidder's USDC payment leg is fired by
   * the bidder's own driver after observing this award.
   */
  bond_token_address: z.string().nullable().optional(),
  principal_usdc_base: z.string().nullable().optional(),
  mint_tx_hash: z.string().nullable().optional(),
  mint_block_number: z.string().nullable().optional(),
});
export type BondAward = z.infer<typeof bondAwardSchema>;

// request-emergency-aid
export const aidRequestSchema = z.object({
  skill: z.literal('request-emergency-aid'),
  requester_fips: fipsSchema,
  reason: z.string().min(1).max(300).describe('Stress reason, e.g. "hurricane Q3 forecast"'),
  amount_usd: z.number().positive(),
  repayment_terms: z.string().min(1).max(300),
});
export type AidRequest = z.infer<typeof aidRequestSchema>;

export const aidResponseSchema = z.object({
  skill: z.literal('request-emergency-aid'),
  kind: z.enum(['offered', 'declined']),
  responder_fips: fipsSchema,
  amount_usd: z.number().nonnegative(),
  yield_bps: z.number().int(),
  rationale: z.string().min(1).max(500),
  /**
   * Phase 4 settlement (responder side). Populated when the responder
   * fires `USDC.transfer(requester, amount)` from their own wallet on
   * `offered`. Mirrors the bond-auction `payIssuer` pattern: primary
   * issuance is direct ERC-20, no AMM. Empty / null when settlement
   * isn't possible (no SwapExecutor, deployments missing, etc.).
   */
  settlement_tx_hash: z.string().nullable().optional(),
  settlement_block_number: z.string().nullable().optional(),
  settlement_amount_usdc_base: z.string().nullable().optional(),
  settlement_recipient: z.string().nullable().optional(),
});
export type AidResponse = z.infer<typeof aidResponseSchema>;

// coordinate-shock-response
export const shockSignalSchema = z.object({
  skill: z.literal('coordinate-shock-response'),
  initiator_fips: fipsSchema,
  shock_kind: z.enum(['natural_disaster', 'market_shock', 'policy_shock']),
  affected_fips: z.array(fipsSchema),
  severity: z.number().int().min(1).max(10),
  proposed_action: z.string().min(1).max(500),
});
export type ShockSignal = z.infer<typeof shockSignalSchema>;

export const shockContributionSchema = z.object({
  skill: z.literal('coordinate-shock-response'),
  kind: z.enum(['joining', 'abstaining']),
  responder_fips: fipsSchema,
  commitment_usd: z.number().nonnegative(),
  rationale: z.string().min(1).max(500),
});
export type ShockContribution = z.infer<typeof shockContributionSchema>;

/**
 * Top-level discriminated union for the 4 new skills' first messages.
 * Routed by `skill`; the executor dispatches to the matching handler.
 */
export const skillEnvelopeSchema = z.discriminatedUnion('skill', [
  coalitionInviteSchema,
  bondBidSchema,
  aidRequestSchema,
  shockSignalSchema,
]);
export type SkillEnvelope = z.infer<typeof skillEnvelopeSchema>;
