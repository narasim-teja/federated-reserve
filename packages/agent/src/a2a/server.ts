/**
 * Per-agent A2A server.
 *
 * Wire layout (matches what AXL forwards to `a2a_addr`):
 *   GET  /.well-known/agent-card.json   → returns the AgentCard JSON
 *   POST /                              → JSON-RPC body for message/send,
 *                                          tasks/get, tasks/cancel, ...
 *
 * Built on `@a2a-js/sdk`'s `DefaultRequestHandler` + `JsonRpcTransportHandler`,
 * served by `Bun.serve`. Replaces the bundled Python `a2a_serving.a2a_server`
 * (which is single-shot only and can't host the multi-turn lifecycle).
 *
 * Streaming (`message/stream`) is left for Phase 5 when the observer node
 * needs SSE; Phase 1 only exercises blocking `message/send`.
 */

import type { AgentCard } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AgentConfig } from '../config.ts';
import type { DataPlaneClient } from '../data-plane-client.ts';
import type { SwapExecutor } from '../execute.ts';
import type { ObserverTelemetry } from '../observer-client.ts';
import type { Reasoner } from '../reason.ts';
import type { AgentState } from '../state.ts';
import { buildAgentCard } from './card.ts';
import { FederatedReserveAgentExecutor } from './executor.ts';

export interface A2aServerHandle {
  port: number;
  agentCard: AgentCard;
  stop: () => void;
}

export function startA2aServer(
  cfg: AgentConfig,
  state: AgentState,
  reasoner?: Reasoner,
  systemPrompt?: string,
  swapExecutor?: SwapExecutor,
  dataPlane?: DataPlaneClient,
  telemetry?: ObserverTelemetry,
): A2aServerHandle {
  const agentCard = buildAgentCard(cfg);
  const taskStore = new InMemoryTaskStore();
  const executor = new FederatedReserveAgentExecutor(
    cfg,
    state,
    reasoner,
    systemPrompt,
    swapExecutor,
    dataPlane,
    telemetry,
  );
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
  const transport = new JsonRpcTransportHandler(requestHandler);

  const server = Bun.serve({
    port: cfg.a2a.serverPort,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      // ---------- AgentCard discovery ---------------------------------
      if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') {
        return Response.json(agentCard);
      }

      // ---------- JSON-RPC POST -------------------------------------
      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
        let body: unknown;
        try {
          body = await req.json();
        } catch (err) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: `parse error: ${(err as Error).message}` },
            },
            { status: 400 },
          );
        }

        const result = await transport.handle(body);
        // Phase 1 only uses blocking message/send and tasks/get — both
        // resolve to a single response. message/stream returns an
        // AsyncGenerator; we'll wire SSE in Phase 5.
        if (typeof (result as AsyncGenerator).next === 'function') {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32601,
                message: 'streaming not yet wired in Phase 1; use message/send',
              },
            },
            { status: 501 },
          );
        }
        return Response.json(result);
      }

      return new Response('not found', { status: 404 });
    },
  });

  console.log(
    `[${cfg.state.abbr}] A2A server listening on http://127.0.0.1:${cfg.a2a.serverPort} ` +
      `(skills: ${agentCard.skills.map((s) => s.id).join(', ')})`,
  );

  return {
    port: cfg.a2a.serverPort,
    agentCard,
    stop: () => {
      server.stop();
    },
  };
}
