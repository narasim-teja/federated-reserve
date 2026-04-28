/**
 * Thin TypeScript client for the AXL HTTP bridge (`localhost:9002` by default).
 *
 * Surface (per `vendor/axl/docs/api.md`):
 *   GET  /topology            → { our_public_key, peers, tree, ... }
 *   POST /send                → fire-and-forget binary send to a peer
 *   GET  /recv                → poll inbound (raw bytes; MCP/A2A are auto-routed)
 *   POST /mcp/{peer}/{svc}    → JSON-RPC over MCP transport envelope
 *   POST /a2a/{peer}          → JSON-RPC over A2A transport envelope
 *   GET  /a2a/{peer}          → fetch remote AgentCard
 *
 * AXL has no GossipSub primitive; broadcasts are application-level fan-outs
 * over `/mcp/{peer}/{svc}` against every peer in `/topology`.
 */

export interface AxlPeer {
  /** Hex-encoded ed25519 public key (64 chars). */
  public_key: string;
  /** Yggdrasil IPv6 of the peer. */
  ipv6?: string;
  /** Other fields exist (port, link state, parent, sequence, ...) — ignore them. */
  [k: string]: unknown;
}

export interface AxlTopology {
  our_ipv6: string;
  our_public_key: string;
  /** Direct dial-link peers (config Listen/Peers). */
  peers: AxlPeer[];
  /** Yggdrasil spanning tree — all reachable nodes including indirect ones. */
  tree?: AxlPeer[];
}

export class AxlClient {
  constructor(private readonly apiUrl: string) {}

  async topology(): Promise<AxlTopology> {
    const res = await fetch(`${this.apiUrl}/topology`);
    if (!res.ok) {
      throw new Error(`AXL /topology failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as AxlTopology;
  }

  /**
   * Returns the set of pubkeys reachable through this node, excluding self.
   * Uses the Yggdrasil spanning `tree` — `peers` is direct-dial only and
   * misses indirect peers (e.g. siblings under a shared hub).
   */
  async peerPubkeys(): Promise<string[]> {
    const top = await this.topology();
    const seen = new Set<string>();
    const collect = (xs: AxlPeer[] | undefined) => {
      for (const x of xs ?? []) {
        if (
          typeof x.public_key === 'string' &&
          x.public_key &&
          x.public_key !== top.our_public_key
        ) {
          seen.add(x.public_key);
        }
      }
    };
    collect(top.tree);
    collect(top.peers); // belt + braces; includes anyone tree might lag on
    return [...seen];
  }

  /**
   * Wait until at least `min` peers are reachable AND the gVisor TCP listener
   * has settled (3-6s after `/topology` reports a peer per Phase 0 finding).
   */
  async waitForPeers(min: number, timeoutMs = 30_000): Promise<string[]> {
    const start = Date.now();
    let pubkeys: string[] = [];
    while (Date.now() - start < timeoutMs) {
      try {
        pubkeys = await this.peerPubkeys();
        if (pubkeys.length >= min) {
          // Phase 0 gotcha: small grace for gVisor TCP to come up.
          await new Promise((r) => setTimeout(r, 4_000));
          return pubkeys;
        }
      } catch {
        // node may not yet be listening — keep retrying
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `AXL waitForPeers timed out after ${timeoutMs}ms (saw ${pubkeys.length}, need ${min})`,
    );
  }

  /** POST a JSON-RPC body to a peer's MCP service. Returns the JSON response. */
  async callRemoteMcp(peerId: string, service: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/mcp/${peerId}/${service}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`/mcp/${peerId}/${service} failed: ${res.status} ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`/mcp/${peerId}/${service} returned non-JSON: ${text}`);
    }
  }

  /** Fetch a peer's A2A AgentCard via `GET /a2a/{peer_id}`. */
  async getRemoteAgentCard(peerId: string): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/a2a/${peerId}`, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET /a2a/${peerId} failed: ${res.status} ${text}`);
    }
    return JSON.parse(text);
  }

  /** POST a JSON-RPC body to a peer's A2A server. */
  async callRemoteA2a(peerId: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/a2a/${peerId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST /a2a/${peerId} failed: ${res.status} ${text}`);
    }
    return JSON.parse(text);
  }
}
