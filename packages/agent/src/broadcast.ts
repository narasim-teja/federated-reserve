/**
 * Application-level broadcast helper.
 *
 * AXL's HTTP surface is `/topology`, `/send`, `/recv`, `/mcp/`, `/a2a/` —
 * there is no native pubsub primitive. To "broadcast" something, we call
 * `/topology` to enumerate peers and fan the same MCP `tools/call` out to
 * each one. Cost is O(N) per broadcast, which is fine for a 50-node mesh
 * with quarter-hourly tick semantics.
 *
 * If a peer is unreachable, we log and continue — broadcast is best-effort,
 * the receiver will pull the indicator next tick if it cares.
 */

import { TREASURER_SERVICE_NAME, type ShareEconomicIndicatorInput } from '@federated-reserve/shared';
import { MCP_TOOLS } from '@federated-reserve/shared';
import type { AgentConfig } from './config.ts';
import type { AxlClient } from './axl-client.ts';

let broadcastSeq = 1;

export interface BroadcastResult {
  peer: string;
  ok: boolean;
  error?: string;
}

export async function broadcastIndicator(
  cfg: AgentConfig,
  axl: AxlClient,
  input: ShareEconomicIndicatorInput,
): Promise<BroadcastResult[]> {
  const peers = await axl.peerPubkeys();
  if (peers.length === 0) {
    console.log(`[${cfg.state.abbr}] no peers to broadcast to (yet)`);
    return [];
  }

  const id = broadcastSeq++;
  const body = {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call' as const,
    params: {
      name: MCP_TOOLS.SHARE_ECONOMIC_INDICATOR,
      arguments: input,
    },
  };

  const results = await Promise.all(
    peers.map(async (peer): Promise<BroadcastResult> => {
      try {
        await axl.callRemoteMcp(peer, TREASURER_SERVICE_NAME, body);
        return { peer, ok: true };
      } catch (err) {
        return { peer, ok: false, error: String(err) };
      }
    }),
  );

  const ok = results.filter((r) => r.ok).length;
  console.log(
    `[${cfg.state.abbr}] broadcast ${input.indicator}=${input.value} → ${ok}/${peers.length} peers`,
  );
  return results;
}
