/**
 * AgentExecutor — top-level dispatcher.
 *
 * Routes inbound A2A messages to a per-skill handler. Two dispatch modes:
 *
 *   1. Legacy (Phase 1 backward compat): if the inbound message's DataPart
 *      doesn't have a `skill` field but does have one of the
 *      negotiate-bilateral-swap `kind`s (proposal/counter/accept/reject),
 *      route to `handleNegotiateSwap`. This keeps `scripts/test-a2a-negotiate.sh`
 *      green without modification.
 *
 *   2. Skill envelope (Phase 2+): if the DataPart has a top-level `skill`
 *      field, route by that. The four new skills (coalition, bond, aid,
 *      shock) live behind this branch.
 *
 * All handlers share the helpers at the bottom (failTask, settlement
 * messaging, persona context).
 */

import { randomUUID } from 'node:crypto';
import type { DataPart, Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import {
  type AidResponse,
  type AssetAmount,
  type BondAward,
  type BondBid,
  type CoalitionResponse,
  type CreditAssessment,
  type EconomicIndicatorKind,
  type ShockContribution,
  type SwapCounter,
  type SwapSettlement,
  type SwapTxLeg,
  assessCredit,
  getBond,
  getPersona,
  getStateToken,
  getUsdc,
  hasCoalitionAffinity,
  loadDeployments,
  lookupStateByFips,
  negotiateSwapMessageSchema,
  resolveAsset,
  skillEnvelopeSchema,
} from '@federated-reserve/shared';
import type { AgentConfig } from '../config.ts';
import type { SwapExecutor } from '../execute.ts';
import type { Reasoner } from '../reason.ts';
import type { AgentState } from '../state.ts';
import {
  type BondAuctionEvaluation,
  type BondMintSettler,
  BondAuctionRegistry,
} from './bond-auction-registry.ts';

const MAX_NEGOTIATION_ROUNDS = 3;

function applyBpsHaircut(amount: string, bps: number): string {
  const big = BigInt(amount);
  const haircut = (big * BigInt(10_000 - bps)) / 10_000n;
  return haircut.toString();
}

function findDataPart(message: Message): DataPart | undefined {
  return message.parts.find((p): p is DataPart => p.kind === 'data');
}

function isoNow(): string {
  return new Date().toISOString();
}

interface ReasonerDecision {
  action: 'accept' | 'counter' | 'reject';
  give?: AssetAmount;
  receive?: AssetAmount;
  rationale: string;
}

export class FederatedReserveAgentExecutor implements AgentExecutor {
  /**
   * Phase 4 — multi-bidder bond auction coordinator. Each `handleBondBid`
   * call parks its bid here and awaits the outcome; the registry
   * evaluates after `windowMs` (or `maxBidsForEval` reached), settles
   * mint for the winner, and resolves all parked promises.
   */
  private readonly bondAuctions: BondAuctionRegistry;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly state: AgentState,
    private readonly reasoner?: Reasoner,
    private readonly systemPrompt: string = '',
    private readonly swapExecutor?: SwapExecutor,
  ) {
    this.bondAuctions = new BondAuctionRegistry({
      windowMs: cfg.bondAuction.windowMs,
      maxBidsForEval: cfg.bondAuction.maxBidsForEval,
    });
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: taskId,
      status: { state: 'canceled', timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    eventBus.finished();
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const dataPart = findDataPart(ctx.userMessage);
    if (!dataPart) {
      this.failTask(ctx, bus, 'no DataPart in user message');
      return;
    }
    const data = dataPart.data as Record<string, unknown>;

    // Branch 2: skill envelope
    if (typeof data.skill === 'string') {
      const parsed = skillEnvelopeSchema.safeParse(data);
      if (!parsed.success) {
        this.failTask(ctx, bus, `invalid skill envelope: ${parsed.error.message}`);
        return;
      }
      const env = parsed.data;
      switch (env.skill) {
        case 'participate-in-coalition':
          await this.handleCoalitionInvite(ctx, bus, env);
          return;
        case 'bond-auction':
          await this.handleBondBid(ctx, bus, env);
          return;
        case 'request-emergency-aid':
          await this.handleAidRequest(ctx, bus, env);
          return;
        case 'coordinate-shock-response':
          await this.handleShockSignal(ctx, bus, env);
          return;
      }
    }

    // Branch 1: legacy negotiate-bilateral-swap (no top-level skill field)
    await this.handleNegotiateSwap(ctx, bus, dataPart);
  }

  // ========================================================================
  // negotiate-bilateral-swap (Phase 1 + Phase 2 reasoning)
  // ========================================================================

  private async handleNegotiateSwap(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    dataPart: DataPart,
  ): Promise<void> {
    const parsed = negotiateSwapMessageSchema.safeParse(dataPart.data);
    if (!parsed.success) {
      this.failTask(ctx, bus, `invalid negotiation payload: ${parsed.error.message}`);
      return;
    }
    const incoming = parsed.data;

    if (!ctx.task) {
      if (incoming.kind !== 'proposal') {
        this.failTask(ctx, bus, `first message must be a proposal, got ${incoming.kind}`);
        return;
      }

      const decision = await this.decideOnProposal(
        incoming.give,
        incoming.receive,
        incoming.rationale,
        1,
      );

      const task: Task = {
        kind: 'task',
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'working', timestamp: isoNow() },
        history: [ctx.userMessage],
      };
      bus.publish(task);

      if (decision.action === 'reject') {
        this.publishStatus(ctx, bus, 'failed', `rejected: ${decision.rationale}`, true);
        return;
      }
      if (decision.action === 'accept') {
        const settlement = await this.makeSettlement(
          incoming.initiator_fips,
          incoming.give,
          incoming.receive,
          1,
        );
        bus.publish({
          kind: 'status-update',
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state: 'completed',
            message: this.dataMessage(ctx, settlement),
            timestamp: isoNow(),
          },
          final: true,
        } satisfies TaskStatusUpdateEvent);
        bus.finished();
        return;
      }

      const counter: SwapCounter = {
        kind: 'counter',
        responder_fips: this.cfg.state.fips,
        give: decision.give ?? {
          asset: incoming.receive.asset,
          amount: applyBpsHaircut(incoming.receive.amount, 500),
        },
        receive: decision.receive ?? incoming.give,
        rationale: decision.rationale,
      };
      bus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: 'input-required',
          message: this.dataMessage(ctx, counter),
          timestamp: isoNow(),
        },
        final: false,
      } satisfies TaskStatusUpdateEvent);
      bus.finished();
      return;
    }

    // Continuation
    const rounds = ctx.task.history?.length ?? 1;
    if (incoming.kind === 'reject') {
      this.failTask(ctx, bus, `initiator rejected: ${incoming.reason}`);
      return;
    }
    if (incoming.kind === 'accept') {
      const settlement = await this.makeSettlement(
        this.findInitiatorFips(ctx.task),
        incoming.agreed_give,
        incoming.agreed_receive,
        rounds,
      );
      bus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: 'completed',
          message: this.dataMessage(ctx, settlement),
          timestamp: isoNow(),
        },
        final: true,
      } satisfies TaskStatusUpdateEvent);
      bus.finished();
      return;
    }
    if (incoming.kind === 'counter') {
      let decision: ReasonerDecision;
      if (rounds >= MAX_NEGOTIATION_ROUNDS) {
        decision = { action: 'accept', rationale: 'round cap reached, accepting' };
      } else {
        decision = await this.decideOnCounter(
          incoming.give,
          incoming.receive,
          incoming.rationale,
          rounds,
        );
      }
      if (decision.action === 'reject') {
        this.failTask(ctx, bus, `counter rejected: ${decision.rationale}`);
        return;
      }
      const settlement = await this.makeSettlement(
        this.findInitiatorFips(ctx.task),
        incoming.give,
        incoming.receive,
        rounds,
      );
      bus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: 'completed',
          message: this.dataMessage(ctx, settlement),
          timestamp: isoNow(),
        },
        final: true,
      } satisfies TaskStatusUpdateEvent);
      bus.finished();
      return;
    }

    this.failTask(ctx, bus, `unexpected continuation kind: ${(incoming as { kind: string }).kind}`);
  }

  private async decideOnProposal(
    give: AssetAmount,
    receive: AssetAmount,
    rationale: string,
    round: number,
  ): Promise<ReasonerDecision> {
    if (this.reasoner && this.cfg.reasoningEnabled) {
      try {
        return await this.askSwapReasoner({
          phase: 'proposal',
          their_give: give,
          their_receive: receive,
          their_rationale: rationale,
          round,
        });
      } catch (err) {
        console.warn(
          `[${this.cfg.state.abbr}] reasoner failed on proposal (${String(err)}); using deterministic counter`,
        );
      }
    }
    return {
      action: 'counter',
      give: { asset: receive.asset, amount: applyBpsHaircut(receive.amount, 500) },
      receive: give,
      rationale: `${this.cfg.state.abbr} counter: 500bps haircut on receive leg vs initial proposal.`,
    };
  }

  private async decideOnCounter(
    give: AssetAmount,
    receive: AssetAmount,
    rationale: string,
    round: number,
  ): Promise<ReasonerDecision> {
    if (this.reasoner && this.cfg.reasoningEnabled) {
      try {
        return await this.askSwapReasoner({
          phase: 'counter',
          their_give: give,
          their_receive: receive,
          their_rationale: rationale,
          round,
        });
      } catch (err) {
        console.warn(
          `[${this.cfg.state.abbr}] reasoner failed on counter (${String(err)}); accepting deterministically`,
        );
      }
    }
    return { action: 'accept', rationale: 'deterministic fallback: accept after round 2' };
  }

  private async askSwapReasoner(args: {
    phase: 'proposal' | 'counter';
    their_give: AssetAmount;
    their_receive: AssetAmount;
    their_rationale: string;
    round: number;
  }): Promise<ReasonerDecision> {
    const userMessage = [
      `Skill: negotiate-bilateral-swap. Round ${args.round} of ${MAX_NEGOTIATION_ROUNDS}.`,
      this.treasuryContextLine(),
      `Latest indicators: ${this.recentIndicatorsSummary()}`,
      args.phase === 'proposal'
        ? 'A counterparty has sent you a swap PROPOSAL. They want to give you `their_give` in exchange for receiving `their_receive` from you.'
        : 'A counterparty has sent you a COUNTER. The terms below are what they now propose; you may accept, counter-counter, or reject.',
      `Their offer: their_give=${JSON.stringify(args.their_give)}, their_receive=${JSON.stringify(args.their_receive)}`,
      `Their rationale: ${args.their_rationale}`,
      '',
      'Decide. Respond ONLY with a JSON object of the shape:',
      '{ "action": "accept" | "counter" | "reject",',
      '  "give": { "asset": string, "amount": "<bigint-as-string>" } | null,',
      '  "receive": { "asset": string, "amount": "<bigint-as-string>" } | null,',
      '  "rationale": "<one short sentence>" }',
      '',
      'If action="counter", include `give` and `receive` (your terms). Use the same asset symbols. Keep amount as a numeric string of integer base units.',
      'If action="accept" or "reject", set give and receive to null.',
    ].join('\n');

    if (!this.reasoner) throw new Error('reasoner not configured');
    const result = await this.reasoner.reasonJson<ReasonerDecision>({
      tier: this.cfg.state.tier,
      system: this.systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    return result.value;
  }

  // ========================================================================
  // participate-in-coalition (Phase 2 single-round)
  // ========================================================================

  private async handleCoalitionInvite(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'participate-in-coalition' }
    >,
  ): Promise<void> {
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'working', timestamp: isoNow() },
      history: [ctx.userMessage],
    } satisfies Task);

    const affinity = hasCoalitionAffinity(this.cfg.state.abbr, env.coalition_tag);

    let response: CoalitionResponse;
    if (this.reasoner && this.cfg.reasoningEnabled) {
      try {
        const prompt = [
          'Skill: participate-in-coalition. A peer is inviting you to join a coalition.',
          `Coalition tag: ${env.coalition_tag}. Topic: "${env.topic}". Proposed contribution: $${env.proposed_contribution_usd}.`,
          this.treasuryContextLine(),
          'Decide whether to join. Respond ONLY with JSON:',
          '{ "kind": "joined" | "declined", "contribution_usd": <number>, "rationale": "<one sentence>" }',
          'If joining, contribution_usd may match or differ from proposal. If declining, set contribution_usd to 0.',
        ].join('\n');
        const result = await this.reasoner.reasonJson<{
          kind: 'joined' | 'declined';
          contribution_usd: number;
          rationale: string;
        }>({
          tier: this.cfg.state.tier,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });
        response = {
          skill: 'participate-in-coalition',
          kind: result.value.kind,
          responder_fips: this.cfg.state.fips,
          contribution_usd: result.value.contribution_usd,
          rationale: result.value.rationale,
        };
      } catch (err) {
        console.warn(`[${this.cfg.state.abbr}] coalition reasoner failed; using affinity fallback`);
        response = this.coalitionFallback(env, affinity);
      }
    } else {
      response = this.coalitionFallback(env, affinity);
    }

    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'completed', message: this.dataMessage(ctx, response), timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }

  private coalitionFallback(
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'participate-in-coalition' }
    >,
    affinity: boolean,
  ): CoalitionResponse {
    return {
      skill: 'participate-in-coalition',
      kind: affinity ? 'joined' : 'declined',
      responder_fips: this.cfg.state.fips,
      contribution_usd: affinity ? env.proposed_contribution_usd : 0,
      rationale: affinity
        ? `${this.cfg.state.abbr} joins on natural affinity with ${env.coalition_tag}.`
        : `${this.cfg.state.abbr} declines: no affinity with ${env.coalition_tag}.`,
    };
  }

  // ========================================================================
  // bond-auction (Phase 4 multi-bidder)
  // ========================================================================
  //
  // Phase 3 evaluated each bid immediately and awarded/rejected per task.
  // Phase 4 coordinates bids per `bond_id` via `BondAuctionRegistry`: each
  // task parks its bid, awaits the auction outcome, and emits Completed
  // with the per-bidder award. Lowest yield wins (with credit-rating
  // floor/ceiling guardrails). The winning bid triggers a single
  // BondToken.mint inside the registry's settler callback.

  private async handleBondBid(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    env: Extract<import('@federated-reserve/shared').SkillEnvelope, { skill: 'bond-auction' }>,
  ): Promise<void> {
    console.log(
      `[${this.cfg.state.abbr}] bond-auction bid received: ${env.bond_id} from FIPS ${env.bidder_fips} principal=$${env.principal_usd} yield=${env.bid_yield_bps}bps`,
    );

    // Park the task in working state — the auction will resolve it.
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'working', timestamp: isoNow() },
      history: [ctx.userMessage],
    } satisfies Task);

    const award = await this.bondAuctions.submitBidAndAwait(
      env,
      (auctionCtx) => this.evaluateBondAuction(env.bond_id, auctionCtx.bids),
      this.makeBondMintSettler(env.bond_id),
    );

    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'completed', message: this.dataMessage(ctx, award), timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }

  /**
   * Issuer-side multi-bidder evaluator.
   *
   *   1. Score the issuer's own credit (= our state) to derive yield
   *      floor and ceiling.
   *   2. Reject bids with yield < floor (predatory; issuer would rather
   *      not borrow at giveaway terms) or yield > ceiling (too expensive).
   *   3. Among the eligible, lowest yield wins. Ties broken by largest
   *      principal (prefer fully-funded bids).
   *   4. The winner gets `kind=awarded`; everyone else `kind=rejected`.
   */
  private async evaluateBondAuction(
    bondId: string,
    bids: ReadonlyArray<BondBid>,
  ): Promise<BondAuctionEvaluation> {
    const credit = this.assessOwnCredit();
    const floor = credit.yieldFloorBps;
    const ceiling = credit.yieldCeilingBps;
    console.log(
      `[${this.cfg.state.abbr}] bond-auction ${bondId} closing with ${bids.length} bid(s); ${credit.summary}`,
    );

    type Eligible = { bid: BondBid; reason: 'eligible' };
    type Ineligible = { bid: BondBid; reason: 'below-floor' | 'above-ceiling' };
    const eligible: Eligible[] = [];
    const ineligible: Ineligible[] = [];
    for (const b of bids) {
      if (b.bid_yield_bps < floor) {
        ineligible.push({ bid: b, reason: 'below-floor' });
      } else if (b.bid_yield_bps > ceiling) {
        ineligible.push({ bid: b, reason: 'above-ceiling' });
      } else {
        eligible.push({ bid: b, reason: 'eligible' });
      }
    }
    eligible.sort((a, b) => {
      if (a.bid.bid_yield_bps !== b.bid.bid_yield_bps) {
        return a.bid.bid_yield_bps - b.bid.bid_yield_bps;
      }
      return b.bid.principal_usd - a.bid.principal_usd;
    });

    const winner = eligible[0]?.bid ?? null;
    const perBidder: BondAuctionEvaluation['perBidder'] = bids.map((b) => {
      const ineligibleEntry = ineligible.find((x) => x.bid.bidder_fips === b.bidder_fips);
      if (ineligibleEntry) {
        const why =
          ineligibleEntry.reason === 'below-floor'
            ? `Below ${floor}bps floor for ${credit.rating} (${this.cfg.state.abbr}).`
            : `Above ${ceiling}bps ceiling for ${credit.rating} (${this.cfg.state.abbr}).`;
        return {
          bidderFips: b.bidder_fips,
          kind: 'rejected' as const,
          yieldBps: b.bid_yield_bps,
          rationale: `${this.cfg.state.abbr} rejects FIPS ${b.bidder_fips}: ${why}`,
        };
      }
      if (winner && b.bidder_fips === winner.bidder_fips) {
        return {
          bidderFips: b.bidder_fips,
          kind: 'awarded' as const,
          yieldBps: b.bid_yield_bps,
          rationale: `${this.cfg.state.abbr} awards ${bondId} at ${b.bid_yield_bps}bps (lowest of ${eligible.length} eligible bid${eligible.length === 1 ? '' : 's'}). Rating ${credit.rating}, score ${credit.score.toFixed(1)}.`,
        };
      }
      return {
        bidderFips: b.bidder_fips,
        kind: 'rejected' as const,
        yieldBps: b.bid_yield_bps,
        rationale: winner
          ? `${this.cfg.state.abbr} rejects FIPS ${b.bidder_fips}: outbid by FIPS ${winner.bidder_fips} at ${winner.bid_yield_bps}bps.`
          : `${this.cfg.state.abbr} rejects FIPS ${b.bidder_fips}: no eligible bids in window.`,
      };
    });

    return { winnerFips: winner?.bidder_fips ?? null, perBidder };
  }

  /**
   * Build the on-chain mint callback for the registry. Returns null when
   * settlement isn't possible (no SwapExecutor / not the issuer / etc.)
   * so the auction still resolves but the awarded bidder gets empty
   * mint metadata — same semantics as Phase 3's `executeBondMint` skip.
   */
  private makeBondMintSettler(bondId: string): BondMintSettler {
    return async (winningBid) => {
      // Reuse the existing executeBondMint by reconstructing an env-shaped
      // input. The original handler took env directly; here we pass the
      // winning bid and bond_id from registry context.
      return this.executeBondMint({
        skill: 'bond-auction',
        issuer_fips: this.cfg.state.fips,
        bidder_fips: winningBid.bidder_fips,
        bond_id: bondId,
        principal_usd: winningBid.principal_usd,
        bid_yield_bps: winningBid.bid_yield_bps,
        rationale: winningBid.rationale,
      });
    };
  }

  /** Score this agent's own state for bond issuance pricing. */
  private assessOwnCredit(): CreditAssessment {
    const indicators = this.state.ownSnapshot?.indicators ?? {};
    const unemploymentPct = indicators.unemployment?.value ?? null;
    const personalIncomeUsd = indicators.personal_income?.value ?? null;
    return assessCredit(this.cfg.state.abbr, {
      reserveRatio: this.state.reserveRatio,
      unemploymentPct,
      personalIncomeUsd,
      region: this.cfg.state.region,
    });
  }

  /**
   * Phase 3 — when this agent is the bond's issuer and the award is
   * `awarded`, mint the BondToken to the bidder. Returns null when
   * settlement isn't possible (no SwapExecutor, bond not in deployments,
   * not the issuer, etc.) so the award still emits with kind=awarded but
   * empty mint metadata — the auction logic itself stays decoupled from
   * onchain availability.
   */
  private async executeBondMint(
    env: Extract<import('@federated-reserve/shared').SkillEnvelope, { skill: 'bond-auction' }>,
  ): Promise<
    | { bondAddress: string; principalUsdcBase: bigint; txHash: string; blockNumber: bigint }
    | null
  > {
    if (!this.swapExecutor || !this.cfg.settlement.enabled) {
      console.warn(
        `[${this.cfg.state.abbr}] bond mint skip: swapExecutor=${!!this.swapExecutor} settlement.enabled=${this.cfg.settlement.enabled}`,
      );
      return null;
    }
    let deployments: ReturnType<typeof loadDeployments>;
    try {
      deployments = loadDeployments('unichain-sepolia');
    } catch (err) {
      console.warn(
        `[${this.cfg.state.abbr}] bond mint skip: deployments unavailable (${String(err)})`,
      );
      return null;
    }
    const bond = getBond(deployments, env.bond_id);
    if (!bond) {
      console.warn(`[${this.cfg.state.abbr}] bond mint skip: ${env.bond_id} not deployed`);
      return null;
    }
    if (bond.issuerFips !== this.cfg.state.fips) {
      console.warn(
        `[${this.cfg.state.abbr}] bond mint skip: issuer FIPS ${bond.issuerFips} != my FIPS ${this.cfg.state.fips}`,
      );
      return null;
    }
    const bidder = lookupStateByFips(env.bidder_fips);
    if (!bidder) {
      console.warn(`[${this.cfg.state.abbr}] bond mint skip: unknown bidder FIPS ${env.bidder_fips}`);
      return null;
    }
    const bidderAddrEnv = process.env[`WALLET_${bidder.abbr}_ADDRESS`];
    if (!bidderAddrEnv) {
      console.warn(
        `[${this.cfg.state.abbr}] bond mint skip: no WALLET_${bidder.abbr}_ADDRESS in env`,
      );
      return null;
    }

    // Mint the principal amount the bidder bid for. Cap at the bond's
    // declared principal so a bidder can't request more than was offered.
    const offered = BigInt(bond.principalUsdcBase);
    const requested = BigInt(env.principal_usd) * 1_000_000n; // USD → 6-decimal base units
    const amount = requested > offered ? offered : requested;

    console.log(
      `[${this.cfg.state.abbr}] bond mint: ${env.bond_id} → ${bidder.abbr} (${bidderAddrEnv}) amount=${amount}`,
    );
    try {
      const r = await this.swapExecutor.mintBond(
        bond.address as `0x${string}`,
        bidderAddrEnv as `0x${string}`,
        amount,
      );
      console.log(
        `[${this.cfg.state.abbr}]   ✓ bond mint tx=${r.txHash} block=${r.blockNumber} status=${r.status}`,
      );
      if (r.status !== 'success') return null;
      return {
        bondAddress: bond.address,
        principalUsdcBase: amount,
        txHash: r.txHash,
        blockNumber: r.blockNumber,
      };
    } catch (err) {
      console.warn(`[${this.cfg.state.abbr}]   bond mint FAILED: ${(err as Error).message}`);
      return null;
    }
  }

  // ========================================================================
  // request-emergency-aid (Phase 2 reasoning + Phase 4 onchain settlement)
  // ========================================================================

  private async handleAidRequest(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'request-emergency-aid' }
    >,
  ): Promise<void> {
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'working', timestamp: isoNow() },
      history: [ctx.userMessage],
    } satisfies Task);

    let response: AidResponse;
    if (this.reasoner && this.cfg.reasoningEnabled) {
      try {
        const prompt = [
          'Skill: request-emergency-aid (you are evaluating an aid request from a peer).',
          `Requester FIPS ${env.requester_fips} asks for $${env.amount_usd}. Reason: "${env.reason}". Repayment terms: "${env.repayment_terms}".`,
          this.treasuryContextLine(),
          'Decide whether to offer aid (full, partial, or decline).',
          'Respond ONLY with JSON: { "kind": "offered" | "declined", "amount_usd": <number>, "yield_bps": <int>, "rationale": "<one sentence>" }',
          'If declining, amount_usd=0 and yield_bps=0. If offering, amount_usd ≤ requested, yield_bps reflects pricing.',
        ].join('\n');
        const result = await this.reasoner.reasonJson<{
          kind: 'offered' | 'declined';
          amount_usd: number;
          yield_bps: number;
          rationale: string;
        }>({
          tier: this.cfg.state.tier,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });
        response = {
          skill: 'request-emergency-aid',
          kind: result.value.kind,
          responder_fips: this.cfg.state.fips,
          amount_usd: result.value.amount_usd,
          yield_bps: result.value.yield_bps,
          rationale: result.value.rationale,
        };
      } catch (err) {
        console.warn(`[${this.cfg.state.abbr}] aid reasoner failed; using deterministic decline`);
        response = this.aidFallback(env);
      }
    } else {
      response = this.aidFallback(env);
    }

    // Phase 4 settlement (responder side). On `offered` and when our
    // wallet is wired up, fire `USDC.transfer(requester, amount)` from
    // our wallet. Failure does NOT fail the task — the response still
    // emits with kind=offered but empty settlement metadata; requester's
    // driver can decide whether to retry or accept the offer at their
    // own risk.
    if (response.kind === 'offered' && response.amount_usd > 0) {
      const settlement = await this.executeAidTransfer(env.requester_fips, response.amount_usd);
      if (settlement) {
        response = {
          ...response,
          settlement_tx_hash: settlement.txHash,
          settlement_block_number: settlement.blockNumber.toString(),
          settlement_amount_usdc_base: settlement.amount.toString(),
          settlement_recipient: settlement.recipient,
        };
      }
    }

    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'completed', message: this.dataMessage(ctx, response), timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }

  /**
   * Phase 4 — fire `USDC.transfer(requester, amount)` from this agent's
   * wallet. Returns null when settlement isn't possible (no SwapExecutor,
   * deployments unavailable, requester wallet unknown, transfer reverts).
   */
  private async executeAidTransfer(
    requesterFips: number,
    amountUsd: number,
  ): Promise<
    | { txHash: string; blockNumber: bigint; amount: bigint; recipient: string }
    | null
  > {
    if (!this.swapExecutor || !this.cfg.settlement.enabled) {
      console.warn(
        `[${this.cfg.state.abbr}] aid settlement skip: swapExecutor=${!!this.swapExecutor} enabled=${this.cfg.settlement.enabled}`,
      );
      return null;
    }
    const requester = lookupStateByFips(requesterFips);
    if (!requester) {
      console.warn(`[${this.cfg.state.abbr}] aid settlement skip: unknown requester FIPS ${requesterFips}`);
      return null;
    }
    const requesterAddrEnv = process.env[`WALLET_${requester.abbr}_ADDRESS`];
    if (!requesterAddrEnv) {
      console.warn(
        `[${this.cfg.state.abbr}] aid settlement skip: no WALLET_${requester.abbr}_ADDRESS in env`,
      );
      return null;
    }
    let deployments: ReturnType<typeof loadDeployments>;
    try {
      deployments = loadDeployments('unichain-sepolia');
    } catch (err) {
      console.warn(
        `[${this.cfg.state.abbr}] aid settlement skip: deployments unavailable (${String(err)})`,
      );
      return null;
    }
    const usdc = getUsdc(deployments);
    // amount_usd → base units (USDC has 6 decimals). Floor at integer USD.
    const amountBase = BigInt(Math.floor(amountUsd)) * 1_000_000n;
    if (amountBase === 0n) return null;

    console.log(
      `[${this.cfg.state.abbr}] aid settlement: ${requester.abbr} (${requesterAddrEnv}) amount=${amountBase} (${amountUsd} USDC)`,
    );
    try {
      const r = await this.swapExecutor.payIssuer(
        usdc.address,
        requesterAddrEnv as `0x${string}`,
        amountBase,
      );
      console.log(
        `[${this.cfg.state.abbr}]   ✓ aid transfer tx=${r.txHash} block=${r.blockNumber} status=${r.status}`,
      );
      if (r.status !== 'success') return null;
      return {
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        amount: amountBase,
        recipient: requesterAddrEnv,
      };
    } catch (err) {
      console.warn(`[${this.cfg.state.abbr}]   aid transfer FAILED: ${(err as Error).message}`);
      return null;
    }
  }

  private aidFallback(
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'request-emergency-aid' }
    >,
  ): AidResponse {
    // Deterministic: offer 25% of request at 600bps if our reserve ratio > 0.10.
    const able = this.state.reserveRatio > 0.1;
    return {
      skill: 'request-emergency-aid',
      kind: able ? 'offered' : 'declined',
      responder_fips: this.cfg.state.fips,
      amount_usd: able ? Math.floor(env.amount_usd * 0.25) : 0,
      yield_bps: able ? 600 : 0,
      rationale: able
        ? `${this.cfg.state.abbr} offers 25% of request at 600bps.`
        : `${this.cfg.state.abbr} declines: own reserve ratio is too thin.`,
    };
  }

  // ========================================================================
  // coordinate-shock-response (Phase 2 single-round)
  // ========================================================================

  private async handleShockSignal(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'coordinate-shock-response' }
    >,
  ): Promise<void> {
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'working', timestamp: isoNow() },
      history: [ctx.userMessage],
    } satisfies Task);

    const affected = env.affected_fips.includes(this.cfg.state.fips);

    let response: ShockContribution;
    if (this.reasoner && this.cfg.reasoningEnabled) {
      try {
        const prompt = [
          'Skill: coordinate-shock-response. A peer has signaled a shock and proposed a coordinated response.',
          `Shock kind: ${env.shock_kind}. Severity: ${env.severity}/10. Affected FIPS: [${env.affected_fips.join(', ')}].`,
          `Initiator's proposed action: "${env.proposed_action}".`,
          `You are ${affected ? 'AFFECTED' : 'NOT directly affected'} by this shock.`,
          this.treasuryContextLine(),
          'Decide whether to commit capital to the joint response.',
          'Respond ONLY with JSON: { "kind": "joining" | "abstaining", "commitment_usd": <number>, "rationale": "<one sentence>" }',
        ].join('\n');
        const result = await this.reasoner.reasonJson<{
          kind: 'joining' | 'abstaining';
          commitment_usd: number;
          rationale: string;
        }>({
          tier: this.cfg.state.tier,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });
        response = {
          skill: 'coordinate-shock-response',
          kind: result.value.kind,
          responder_fips: this.cfg.state.fips,
          commitment_usd: result.value.commitment_usd,
          rationale: result.value.rationale,
        };
      } catch (err) {
        console.warn(`[${this.cfg.state.abbr}] shock reasoner failed; using affinity fallback`);
        response = this.shockFallback(env, affected);
      }
    } else {
      response = this.shockFallback(env, affected);
    }

    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'completed', message: this.dataMessage(ctx, response), timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }

  private shockFallback(
    env: Extract<
      import('@federated-reserve/shared').SkillEnvelope,
      { skill: 'coordinate-shock-response' }
    >,
    affected: boolean,
  ): ShockContribution {
    // Affected states join with severity-scaled commitment; others abstain by default
    // unless they have natural disaster-pool affinity.
    const persona = getPersona(this.cfg.state.abbr);
    const inPool =
      affected ||
      persona.coalitions.includes('gulf-disaster-pool') ||
      persona.coalitions.includes('climate-exposed');
    return {
      skill: 'coordinate-shock-response',
      kind: inPool ? 'joining' : 'abstaining',
      responder_fips: this.cfg.state.fips,
      commitment_usd: inPool ? env.severity * 100_000 : 0,
      rationale: inPool
        ? `${this.cfg.state.abbr} joins ${env.shock_kind} response (${affected ? 'directly affected' : 'pool affinity'}).`
        : `${this.cfg.state.abbr} abstains: no direct exposure or affinity.`,
    };
  }

  // ========================================================================
  // shared helpers
  // ========================================================================

  private treasuryContextLine(): string {
    return `Your treasury: reserve_ratio=${this.state.reserveRatio}, total_value_usd=${this.state.totalValueUsd}, composition=${JSON.stringify(this.state.composition)}`;
  }

  private recentIndicatorsSummary(): string {
    const own = this.state.ownSnapshot?.indicators;
    if (!own) return '(no snapshot yet)';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(own)) {
      if (v) parts.push(`${k as EconomicIndicatorKind}=${v.value} (${v.observation_date})`);
    }
    return parts.length ? parts.join(', ') : '(empty snapshot)';
  }

  /**
   * Build the settlement payload. Phase 3: when a SwapExecutor is configured
   * AND the agreed assets resolve to a (USDC × StateToken) pool we hold on
   * Unichain Sepolia, the responder fires its mirror leg here (USDC →
   * initiator's StateToken) before emitting Completed.
   *
   * Failure of the on-chain leg does NOT fail the negotiation — the task
   * still completes; `legs.responder` is null and a warning is logged.
   */
  private async makeSettlement(
    initiatorFips: number,
    agreedGive: AssetAmount,
    agreedReceive: AssetAmount,
    rounds: number,
  ): Promise<SwapSettlement> {
    const responderLeg = await this.executeResponderLeg(initiatorFips, agreedGive, agreedReceive);
    return {
      kind: 'settlement',
      initiator_fips: initiatorFips,
      responder_fips: this.cfg.state.fips,
      agreed_give: agreedGive,
      agreed_receive: agreedReceive,
      rounds,
      legs: { initiator: null, responder: responderLeg },
      tx_hash: responderLeg?.tx_hash ?? null,
      settled_at: isoNow(),
    };
  }

  /**
   * Phase 3 — execute responder's mirror leg of the bilateral swap.
   *
   * Mapping:
   *   initiator gives `agreed_give` (e.g. 1M USDC)
   *   initiator receives `agreed_receive` (e.g. 1M responder's StateToken)
   *   responder mirrors: spend matching USDC for initiator's StateToken
   *
   * The mirror amount equals `agreed_give.amount` when `agreed_give.asset`
   * is USDC (the natural Phase 3 case). If neither side is USDC, we skip
   * on-chain execution because we don't have state×state pools.
   */
  private async executeResponderLeg(
    initiatorFips: number,
    agreedGive: AssetAmount,
    agreedReceive: AssetAmount,
  ): Promise<SwapTxLeg | null> {
    if (!this.swapExecutor || !this.cfg.settlement.enabled) return null;

    const initiator = lookupStateByFips(initiatorFips);
    if (!initiator) {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: unknown initiator FIPS ${initiatorFips}`,
      );
      return null;
    }

    let deployments: ReturnType<typeof loadDeployments>;
    try {
      deployments = loadDeployments('unichain-sepolia');
    } catch (err) {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: deployments unavailable (${String(err)})`,
      );
      return null;
    }

    // Resolve negotiation assets to on-chain tokens.
    let giveTok: ReturnType<typeof getUsdc>;
    let recvTok: ReturnType<typeof getUsdc>;
    try {
      giveTok = resolveAsset(deployments, agreedGive.asset);
      recvTok = resolveAsset(deployments, agreedReceive.asset);
    } catch (err) {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: cannot resolve assets ${agreedGive.asset}/${agreedReceive.asset} (${String(err)})`,
      );
      return null;
    }

    // We require one side to be USDC so we can route through our seeded
    // USDC×StateToken pools. Phase 3 only seeds 5 such pools.
    const usdc = getUsdc(deployments);
    const giveIsUsdc = giveTok.address.toLowerCase() === usdc.address.toLowerCase();
    const recvIsUsdc = recvTok.address.toLowerCase() === usdc.address.toLowerCase();
    if (!giveIsUsdc && !recvIsUsdc) {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: neither side is USDC (give=${agreedGive.asset}, recv=${agreedReceive.asset})`,
      );
      return null;
    }

    // Responder's mirror leg: spend USDC equal to initiator's USDC commitment,
    // buy initiator's StateToken. If the initiator was *receiving* USDC
    // (their StateToken is the give-side), we mirror by acquiring it too —
    // the same pool clears either direction.
    let initiatorStateTok: ReturnType<typeof getUsdc>;
    try {
      initiatorStateTok = getStateToken(deployments, initiator.abbr);
    } catch {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: no StateToken deployed for initiator ${initiator.abbr}`,
      );
      return null;
    }

    // Amount of USDC the responder will spend mirrors what the initiator
    // committed in USDC terms (the `agreed_give.amount` when give is USDC).
    const mirrorUsdcAmount = giveIsUsdc ? agreedGive.amount : agreedReceive.amount;
    let amountIn: bigint;
    try {
      amountIn = BigInt(mirrorUsdcAmount);
    } catch {
      console.warn(
        `[${this.cfg.state.abbr}] settlement skip: bad mirror amount ${mirrorUsdcAmount}`,
      );
      return null;
    }
    if (amountIn === 0n) {
      console.warn(`[${this.cfg.state.abbr}] settlement skip: mirror amount is zero`);
      return null;
    }

    console.log(
      `[${this.cfg.state.abbr}] settlement: responder leg — buying ${initiatorStateTok.symbol} with ${amountIn} USDC base units (initiator=${initiator.abbr})`,
    );

    try {
      const result = await this.swapExecutor.swap({
        tokenIn: usdc.address,
        tokenOut: initiatorStateTok.address,
        amount: amountIn,
        slippageTolerancePct: 1.0,
      });
      console.log(
        `[${this.cfg.state.abbr}]   ✓ responder swap tx=${result.txHash} block=${result.blockNumber} expectedOut=${result.expectedOut}`,
      );
      return {
        fips: this.cfg.state.fips,
        swapper_address: this.swapExecutor.address,
        token_in_symbol: usdc.symbol,
        token_in_address: usdc.address,
        token_out_symbol: initiatorStateTok.symbol,
        token_out_address: initiatorStateTok.address,
        amount_in: amountIn.toString(),
        expected_amount_out: result.expectedOut.toString(),
        tx_hash: result.txHash,
        block_number: result.blockNumber.toString(),
        status: result.status,
        quote_request_id: result.quoteRequestId,
        swap_request_id: result.swapRequestId,
      };
    } catch (err) {
      console.warn(
        `[${this.cfg.state.abbr}]   responder swap FAILED: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private dataMessage(ctx: RequestContext, payload: unknown): Message {
    return {
      kind: 'message',
      messageId: randomUUID(),
      role: 'agent',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      parts: [{ kind: 'data', data: payload as Record<string, unknown> }],
    };
  }

  private findInitiatorFips(task: Task): number {
    for (const msg of task.history ?? []) {
      const dp = findDataPart(msg as Message);
      if (!dp) continue;
      const parsed = negotiateSwapMessageSchema.safeParse(dp.data);
      if (parsed.success && parsed.data.kind === 'proposal') {
        return parsed.data.initiator_fips;
      }
    }
    return 0;
  }

  private failTask(ctx: RequestContext, bus: ExecutionEventBus, reason: string): void {
    const failureMessage: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: 'agent',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      parts: [{ kind: 'text', text: `task failed: ${reason}` }],
    };
    if (!ctx.task) {
      bus.publish({
        kind: 'task',
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'failed', message: failureMessage, timestamp: isoNow() },
        history: [ctx.userMessage],
      } satisfies Task);
    }
    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'failed', message: failureMessage, timestamp: isoNow() },
      final: true,
    } satisfies TaskStatusUpdateEvent);
    bus.finished();
  }

  private publishStatus(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    state: 'failed' | 'completed' | 'canceled',
    text: string,
    final: boolean,
  ): void {
    const message: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: 'agent',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      parts: [{ kind: 'text', text }],
    };
    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, message, timestamp: isoNow() },
      final,
    } satisfies TaskStatusUpdateEvent);
    if (final) bus.finished();
  }
}
