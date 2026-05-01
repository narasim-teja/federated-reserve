/**
 * Multi-bidder bond auction coordinator (issuer-side state).
 *
 * Phase 3 shipped single-bid auctions: each bidder's task arrived, the
 * issuer evaluated immediately, awarded or rejected, minted to the winner
 * inside the same handler. Phase 4 expands to multi-bidder: the issuer
 * waits for either `windowMs` or `maxBidsForEval` bids before evaluating
 * by lowest yield (with credit-rating-derived floor), then awards exactly
 * one bidder and rejects the others.
 *
 * Used by `FederatedReserveAgentExecutor.handleBondBid` — that handler
 * parks each inbound bid in the registry and `await`s its own slot in
 * the auction outcome before publishing the task's Completed event. The
 * registry handles timer + evaluation + mint settlement for the winner;
 * losers get a rejected award with a clear rationale.
 *
 * Scope: registry is in-memory per-agent-process. Auction state is
 * keyed by `bond_id`. Once an auction evaluates, its key is dropped so
 * a re-issuance of the same `bond_id` (rare) starts fresh.
 */

import type { BondAward, BondBid } from '@federated-reserve/shared';

export interface BondAuctionEvaluatorContext {
  /** All bids received in this auction window (snapshot). */
  bids: ReadonlyArray<BondBid>;
  /** Bid sorted ascending by yield_bps (lowest first). */
  sortedByYieldAsc: ReadonlyArray<BondBid>;
}

export interface BondAuctionEvaluation {
  /** Winning bid; null if all bids rejected (e.g. all above credit ceiling). */
  winnerFips: number | null;
  /** Per-bidder verdict + rationale. Must include every bid in the context. */
  perBidder: ReadonlyArray<{
    bidderFips: number;
    kind: 'awarded' | 'rejected';
    yieldBps: number;
    rationale: string;
  }>;
}

export type BondAuctionEvaluator = (
  ctx: BondAuctionEvaluatorContext,
) => Promise<BondAuctionEvaluation> | BondAuctionEvaluation;

export interface BondMintSettlementResult {
  bondAddress: string;
  principalUsdcBase: bigint;
  txHash: string;
  blockNumber: bigint;
}

/** Issuer-side helper that performs the on-chain mint to the winning bidder. */
export type BondMintSettler = (winningBid: BondBid) => Promise<BondMintSettlementResult | null>;

export interface BondAuctionRegistryConfig {
  /** Auction window after the first bid arrives. */
  windowMs: number;
  /**
   * If this many bids arrive before the timer fires, evaluate
   * immediately. Useful in test mode where the gate test fires N bids
   * back-to-back.
   */
  maxBidsForEval: number;
}

interface ParkedBid {
  bid: BondBid;
  resolve: (award: BondAward) => void;
}

interface AuctionState {
  bondId: string;
  parked: ParkedBid[];
  timer: ReturnType<typeof setTimeout> | null;
  evaluating: boolean;
}

export class BondAuctionRegistry {
  private readonly auctions = new Map<string, AuctionState>();

  constructor(private readonly cfg: BondAuctionRegistryConfig) {}

  /**
   * Park a bid in the auction for `bid.bond_id`. Returns a promise that
   * resolves with the bidder's award (awarded or rejected) once the
   * auction window closes. The auction window starts on the first bid
   * for a given bond_id.
   */
  async submitBidAndAwait(
    bid: BondBid,
    evaluate: BondAuctionEvaluator,
    settler: BondMintSettler | null,
  ): Promise<BondAward> {
    const key = bid.bond_id;
    let auction = this.auctions.get(key);

    if (!auction) {
      auction = {
        bondId: key,
        parked: [],
        timer: null,
        evaluating: false,
      };
      this.auctions.set(key, auction);
    }

    // Auction already concluded but key still in the map: race window
    // between resolution and Map.delete. Reject with a clear marker
    // rather than risk parking into a hung auction.
    if (auction.evaluating) {
      return {
        skill: 'bond-auction',
        kind: 'rejected',
        bond_id: key,
        to_fips: bid.bidder_fips,
        yield_bps: bid.bid_yield_bps,
        rationale: 'auction window already closed before bid was parked',
      };
    }

    const currentAuction = auction;
    const award = new Promise<BondAward>((resolve) => {
      currentAuction.parked.push({ bid, resolve });
    });

    // Start the eval timer on the first bid.
    if (!auction.timer) {
      auction.timer = setTimeout(
        () => void this.runEvaluation(key, evaluate, settler),
        this.cfg.windowMs,
      );
    }

    // If we've hit the bid cap, evaluate now (let the current handler
    // finish parking via microtask first).
    if (auction.parked.length >= this.cfg.maxBidsForEval) {
      if (auction.timer) {
        clearTimeout(auction.timer);
        auction.timer = null;
      }
      queueMicrotask(() => void this.runEvaluation(key, evaluate, settler));
    }

    return award;
  }

  private async runEvaluation(
    bondId: string,
    evaluate: BondAuctionEvaluator,
    settler: BondMintSettler | null,
  ): Promise<void> {
    const auction = this.auctions.get(bondId);
    if (!auction || auction.evaluating) return;
    auction.evaluating = true;
    if (auction.timer) {
      clearTimeout(auction.timer);
      auction.timer = null;
    }

    const bids = auction.parked.map((p) => p.bid);
    const sortedByYieldAsc = [...bids].sort((a, b) => a.bid_yield_bps - b.bid_yield_bps);

    let evaluation: BondAuctionEvaluation;
    try {
      evaluation = await evaluate({ bids, sortedByYieldAsc });
    } catch (err) {
      console.warn(
        `[bond-auction] evaluator for ${bondId} threw: ${(err as Error).message}; rejecting all bids`,
      );
      evaluation = {
        winnerFips: null,
        perBidder: bids.map((b) => ({
          bidderFips: b.bidder_fips,
          kind: 'rejected',
          yieldBps: b.bid_yield_bps,
          rationale: `evaluator failed: ${(err as Error).message}`,
        })),
      };
    }

    // Build a quick lookup so we can resolve each parked bid by its
    // bidder_fips. (Same bidder shouldn't bid twice on the same auction
    // in the gate-test scope, but if they do we resolve the first match.)
    const verdictByFips = new Map<number, BondAuctionEvaluation['perBidder'][number]>();
    for (const v of evaluation.perBidder) {
      if (!verdictByFips.has(v.bidderFips)) verdictByFips.set(v.bidderFips, v);
    }

    // Settle the winner (mint) before resolving so the awarded promise
    // gets the mint tx metadata.
    let settlement: BondMintSettlementResult | null = null;
    if (evaluation.winnerFips !== null && settler) {
      const winningBid = bids.find((b) => b.bidder_fips === evaluation.winnerFips);
      if (winningBid) {
        try {
          settlement = await settler(winningBid);
        } catch (err) {
          console.warn(
            `[bond-auction] mint settler for ${bondId} threw: ${(err as Error).message}`,
          );
        }
      }
    }

    for (const parked of auction.parked) {
      const v = verdictByFips.get(parked.bid.bidder_fips);
      if (!v) {
        // Should never happen — evaluator promised a verdict per bidder.
        parked.resolve({
          skill: 'bond-auction',
          kind: 'rejected',
          bond_id: bondId,
          to_fips: parked.bid.bidder_fips,
          yield_bps: parked.bid.bid_yield_bps,
          rationale: 'evaluator did not produce a verdict for this bidder',
        });
        continue;
      }
      const isWinner = v.kind === 'awarded' && parked.bid.bidder_fips === evaluation.winnerFips;
      const award: BondAward = {
        skill: 'bond-auction',
        kind: v.kind,
        bond_id: bondId,
        to_fips: parked.bid.bidder_fips,
        yield_bps: v.yieldBps,
        rationale: v.rationale,
        ...(isWinner && settlement
          ? {
              bond_token_address: settlement.bondAddress,
              principal_usdc_base: settlement.principalUsdcBase.toString(),
              mint_tx_hash: settlement.txHash,
              mint_block_number: settlement.blockNumber.toString(),
            }
          : {}),
      };
      parked.resolve(award);
    }

    this.auctions.delete(bondId);
  }
}
