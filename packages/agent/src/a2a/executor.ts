/**
 * AgentExecutor for the negotiate-bilateral-swap skill.
 *
 * Phase 1 ships deterministic stub logic so the lifecycle is reproducible
 * without OpenRouter calls — Phase 2 swaps this for a Claude-powered policy.
 *
 * Lifecycle (single conversation, two `message/send` calls from the client):
 *
 *   call 1 (initiator → us):  proposal { give, receive }
 *     → we publish Task (working)
 *     → we publish TaskStatusUpdateEvent (input-required, final=false)
 *       carrying a Message kind=counter with a 5% haircut on `receive`
 *
 *   call 2 (initiator → us):  accept { agreed_give, agreed_receive }
 *     → we publish TaskStatusUpdateEvent (completed, final=true)
 *       carrying a Message kind=settlement with the agreed terms and
 *       the round count.
 *
 * Edge cases:
 *   - reject from initiator   → completed=failed, final=true
 *   - second counter received → we accept it deterministically (test still
 *     converges in 2 rounds)
 *   - any unparseable payload → failed, final=true
 */

import { randomUUID } from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { DataPart, Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  type AssetAmount,
  negotiateSwapMessageSchema,
  type SwapCounter,
  type SwapSettlement,
} from '@federated-reserve/shared';
import type { AgentConfig } from '../config.ts';

/** Bigint-as-string × bps haircut, returning a fresh string. */
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

export class FederatedReserveAgentExecutor implements AgentExecutor {
  constructor(private readonly cfg: AgentConfig) {}

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const update: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: taskId, // best-effort if we don't have the contextId here
      status: { state: 'canceled', timestamp: isoNow() },
      final: true,
    };
    eventBus.publish(update);
    eventBus.finished();
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const userMessage = ctx.userMessage;
    const dataPart = findDataPart(userMessage);

    if (!dataPart) {
      this.failTask(ctx, bus, 'no DataPart in user message — expected negotiation envelope');
      return;
    }

    const parsed = negotiateSwapMessageSchema.safeParse(dataPart.data);
    if (!parsed.success) {
      this.failTask(ctx, bus, `invalid negotiation payload: ${parsed.error.message}`);
      return;
    }
    const incoming = parsed.data;

    if (!ctx.task) {
      // First turn — must be a proposal.
      if (incoming.kind !== 'proposal') {
        this.failTask(ctx, bus, `first message must be a proposal, got ${incoming.kind}`);
        return;
      }
      const counterTerms = this.computeCounter(incoming.give, incoming.receive);

      // 1. Publish the canonical Task snapshot (working).
      const task: Task = {
        kind: 'task',
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'working', timestamp: isoNow() },
        history: [userMessage],
      };
      bus.publish(task);

      // 2. Publish input-required with our counter as the status message.
      const counterMessage: Message = {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        parts: [
          {
            kind: 'data',
            data: {
              kind: 'counter',
              responder_fips: this.cfg.state.fips,
              give: counterTerms.give,
              receive: counterTerms.receive,
              rationale: `${this.cfg.state.abbr} counter: 500bps haircut on receive leg vs initial proposal.`,
            } satisfies SwapCounter,
          },
        ],
      };
      const update: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: 'input-required',
          message: counterMessage,
          timestamp: isoNow(),
        },
        final: false,
      };
      bus.publish(update);
      bus.finished();
      return;
    }

    // Continuation turn — task already exists.
    const rounds = (ctx.task.history?.length ?? 0); // includes the new user message
    if (incoming.kind === 'reject') {
      this.failTask(ctx, bus, `initiator rejected: ${incoming.reason}`);
      return;
    }

    let agreedGive: AssetAmount;
    let agreedReceive: AssetAmount;
    if (incoming.kind === 'accept') {
      agreedGive = incoming.agreed_give;
      agreedReceive = incoming.agreed_receive;
    } else if (incoming.kind === 'counter') {
      // Deterministic: accept any counter-counter on round 2.
      agreedGive = incoming.give;
      agreedReceive = incoming.receive;
    } else {
      this.failTask(ctx, bus, `unexpected continuation kind: ${incoming.kind}`);
      return;
    }

    const settlement: SwapSettlement = {
      kind: 'settlement',
      initiator_fips: this.findInitiatorFips(ctx.task),
      responder_fips: this.cfg.state.fips,
      agreed_give: agreedGive,
      agreed_receive: agreedReceive,
      rounds,
      tx_hash: null, // Phase 3 fills this in after Uniswap execution.
      settled_at: isoNow(),
    };
    const settlementMessage: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: 'agent',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      parts: [{ kind: 'data', data: settlement }],
    };
    const update: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'completed', message: settlementMessage, timestamp: isoNow() },
      final: true,
    };
    bus.publish(update);
    bus.finished();
  }

  // ---------- helpers ------------------------------------------------------

  private computeCounter(initiatorGive: AssetAmount, initiatorReceive: AssetAmount): {
    give: AssetAmount;
    receive: AssetAmount;
  } {
    // We're the responder. Initiator wants to give `initiatorGive` and receive
    // `initiatorReceive` from us. Our counter reduces what we give back by 5%.
    const haircutAmount = applyBpsHaircut(initiatorReceive.amount, 500);
    return {
      give: { asset: initiatorReceive.asset, amount: haircutAmount },
      receive: { asset: initiatorGive.asset, amount: initiatorGive.amount },
    };
  }

  private findInitiatorFips(task: Task): number {
    // Walk task history for the original proposal; default to 0 if missing.
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
      parts: [{ kind: 'text', text: `negotiate-bilateral-swap failed: ${reason}` }],
    };
    if (!ctx.task) {
      // Have to publish a Task first since one doesn't exist.
      const task: Task = {
        kind: 'task',
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'failed', message: failureMessage, timestamp: isoNow() },
        history: [ctx.userMessage],
      };
      bus.publish(task);
    }
    const update: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'failed', message: failureMessage, timestamp: isoNow() },
      final: true,
    };
    bus.publish(update);
    bus.finished();
  }
}

