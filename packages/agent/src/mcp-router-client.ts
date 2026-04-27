/**
 * Per-host Python MCP Router client.
 *
 * The Router (vendor/axl/integrations/mcp_routing) exposes:
 *   POST   /register          { service, endpoint }
 *   DELETE /register/{name}
 *   GET    /services          (debug)
 *   GET    /health
 *
 * We treat it as a sidecar — same trust boundary as the agent — and register
 * once on startup, deregister on shutdown.
 */

export interface RouterRegistration {
  service: string;
  endpoint: string;
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
        // not yet up
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`MCP Router at ${this.routerUrl} not ready after ${timeoutMs}ms`);
  }

  async register(reg: RouterRegistration): Promise<void> {
    const res = await fetch(`${this.routerUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reg),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP Router /register failed: ${res.status} ${text}`);
    }
  }

  async deregister(service: string): Promise<void> {
    try {
      await fetch(`${this.routerUrl}/register/${service}`, { method: 'DELETE' });
    } catch (err) {
      // Best-effort on shutdown — don't throw.
      console.error(`[mcp-router-client] deregister failed: ${String(err)}`);
    }
  }
}
