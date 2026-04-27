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

/** Final settlement record emitted on Completed terminal state. */
export const swapSettlementSchema = z.object({
  kind: z.literal('settlement'),
  initiator_fips: fipsSchema,
  responder_fips: fipsSchema,
  agreed_give: assetAmountSchema,
  agreed_receive: assetAmountSchema,
  rounds: z.number().int().min(1),
  // Phase 3 will populate `tx_hash` after Uniswap execution.
  tx_hash: z.string().nullable(),
  settled_at: z.string(),
});
export type SwapSettlement = z.infer<typeof swapSettlementSchema>;
