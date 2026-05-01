export interface AxlPeer {
  public_key: string;
  [k: string]: unknown;
}

export interface AxlTopology {
  our_public_key: string;
  peers?: AxlPeer[];
  tree?: AxlPeer[];
}

export class AxlClient {
  constructor(private readonly apiUrl: string) {}

  async topology(): Promise<AxlTopology> {
    const res = await fetch(`${this.apiUrl}/topology`);
    if (!res.ok) throw new Error(`AXL /topology failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as AxlTopology;
  }

  async peerPubkeys(): Promise<{ self: string; peers: string[] }> {
    const top = await this.topology();
    const peers = new Set<string>();
    for (const p of [...(top.peers ?? []), ...(top.tree ?? [])]) {
      if (p.public_key && p.public_key !== top.our_public_key) peers.add(p.public_key);
    }
    return { self: top.our_public_key, peers: [...peers] };
  }
}

export class McpRouterClient {
  constructor(private readonly routerUrl: string) {}

  async waitReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.routerUrl}/health`);
        if (res.ok) return;
      } catch {
        // Router is still warming.
      }
      await Bun.sleep(500);
    }
    throw new Error(`MCP Router at ${this.routerUrl} not ready after ${timeoutMs}ms`);
  }

  async register(service: string, endpoint: string): Promise<void> {
    const res = await fetch(`${this.routerUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service, endpoint }),
    });
    if (!res.ok) throw new Error(`MCP Router /register failed: ${res.status} ${await res.text()}`);
  }
}
