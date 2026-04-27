/**
 * Mesh discovery via 1-hop MCP gossip.
 *
 * Why: AXL's `/topology.tree` is eventually-consistent and under-reports for
 * non-hub nodes during early lifetime. Routing works, but a non-hub agent
 * trying to broadcast wouldn't know all its peers exist. So we layer a
 * periodic gossip loop on top: each agent queries its direct peers'
 * `share_topology` MCP tool and unions the returned pubkey sets into a
 * local cache. After 1-2 rounds the mesh converges.
 *
 * This is the "production-grade discovery" Phase 1 originally deferred to
 * Phase 2 — pulled forward because the broadcast helper depends on it.
 */

import {
  MCP_TOOLS,
  TREASURER_SERVICE_NAME,
  shareTopologyResultSchema,
} from '@federated-reserve/shared';
import type { AxlClient } from './axl-client.ts';
import type { AgentConfig } from './config.ts';

interface JsonRpcResult {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { code: number; message: string };
}

function parseInnerToolResult(resp: unknown): unknown {
  // MCP wraps tool results as `{ result: { content: [{ type: 'text', text: '<json>' }] } }`.
  const r = resp as JsonRpcResult;
  if (r.error) throw new Error(`remote MCP error: ${r.error.message}`);
  const text = r.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('unexpected MCP tools/call response shape');
  }
  return JSON.parse(text);
}

export class MeshDiscovery {
  /** Mutable; updated each refresh. Exposed via `knownPeers()`. */
  private known = new Set<string>();
  /** Set on first successful refresh; lets us tell "no peers" apart from "not refreshed yet". */
  private lastRefresh: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly axl: AxlClient,
  ) {}

  /** Pubkeys this agent currently believes are in the mesh, excluding self. */
  knownPeers(): string[] {
    return [...this.known];
  }

  lastRefreshAt(): string | null {
    return this.lastRefresh;
  }

  /**
   * Single refresh pass:
   *   1. Pull own /topology — union peers + tree, exclude self → seed set
   *   2. For each pubkey in seed set, MCP-call its `share_topology` and
   *      union returned pubkeys into the aggregate
   *   3. Replace local cache with the aggregate
   *
   * Best-effort: an unreachable peer is logged and skipped, doesn't fail
   * the whole refresh.
   */
  async refresh(): Promise<void> {
    const top = await this.axl.topology();
    const seeds = new Set<string>();
    for (const p of top.peers ?? []) {
      if (typeof p.public_key === 'string' && p.public_key) seeds.add(p.public_key);
    }
    for (const n of top.tree ?? []) {
      if (typeof n.public_key === 'string' && n.public_key) seeds.add(n.public_key);
    }
    seeds.delete(top.our_public_key);

    const aggregated = new Set(seeds);

    // 1-hop gossip — concurrent, best-effort.
    const gossip = await Promise.all(
      [...seeds].map(async (peer) => {
        try {
          const resp = await this.axl.callRemoteMcp(peer, TREASURER_SERVICE_NAME, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: MCP_TOOLS.SHARE_TOPOLOGY, arguments: {} },
          });
          const inner = parseInnerToolResult(resp);
          const parsed = shareTopologyResultSchema.safeParse(inner);
          if (!parsed.success) return [];
          return parsed.data.peers;
        } catch (err) {
          // Suppress noise during early startup — nodes still warming up.
          return [];
        }
      }),
    );

    for (const list of gossip) {
      for (const k of list) {
        if (k && k !== top.our_public_key) aggregated.add(k);
      }
    }

    this.known = aggregated;
    this.lastRefresh = new Date().toISOString();
  }

  start(intervalMs: number, firstDelayMs = 2_000): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.refresh();
      } catch (err) {
        console.error(`[${this.cfg.state.abbr}] discovery refresh failed: ${String(err)}`);
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
      }
    };
    this.timer = setTimeout(tick, firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
