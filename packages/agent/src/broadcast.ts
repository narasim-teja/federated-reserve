/**
 * Application-level broadcast helper.
 *
 * AXL's HTTP surface is `/topology`, `/send`, `/recv`, `/mcp/`, `/a2a/` —
 * there is no native pubsub primitive. To "broadcast" something, we call
 * the same MCP `tools/call` against every peer in the discovered mesh.
 * Cost is O(N) per broadcast, which is fine for a 50-node mesh with
 * quarter-hourly tick semantics.
 *
 * Peer discovery comes from `MeshDiscovery` (1-hop MCP gossip), not raw
 * `axl.peerPubkeys()` — the latter under-reports for non-hub nodes
 * because Yggdrasil's spanning tree converges asynchronously.
 *
 * If a peer is unreachable, we log and continue — broadcast is best-effort,
 * the receiver will pull the indicator next tick if it cares.
 */

import {
  type ShareEconomicIndicatorInput,
  TREASURER_SERVICE_NAME,
} from '@federated-reserve/shared';
import { MCP_TOOLS } from '@federated-reserve/shared';
import type { AxlClient } from './axl-client.ts';
import type { AgentConfig } from './config.ts';
import type { MeshDiscovery } from './discovery.ts';

let broadcastSeq = 1;

export interface BroadcastResult {
  peer: string;
  ok: boolean;
  error?: string;
}

export async function broadcastIndicator(
  cfg: AgentConfig,
  axl: AxlClient,
  discovery: MeshDiscovery,
  input: ShareEconomicIndicatorInput,
): Promise<BroadcastResult[]> {
  const peers = discovery.knownPeers();
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
