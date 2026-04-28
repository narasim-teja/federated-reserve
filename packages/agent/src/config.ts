/**
 * Per-agent runtime config, populated from env vars.
 *
 * The local-mesh runner offsets ports per agent so 3 agents can coexist on
 * one host. Production (Fly.io) gives each agent its own machine — defaults
 * mirror the spike-01/02 layout.
 */

import { type StateInfo, lookupStateByFips } from '@federated-reserve/shared';

function readNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${key} is not a number: ${v}`);
  }
  return n;
}

function readString(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function readRequiredString(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`required env var missing: ${key}`);
  return v;
}

export interface AgentConfig {
  state: StateInfo;
  axl: {
    apiUrl: string;
  };
  mcp: {
    /** Where the local MCP server listens (Bun.serve). */
    serverPort: number;
    serverEndpoint: string;
    /** Where the Python MCP Router listens (per-host sidecar). */
    routerUrl: string;
    /** Service name we register under. Always "treasurer" so peers know. */
    serviceName: string;
  };
  a2a: {
    /** Where the local A2A server listens (Bun.serve). */
    serverPort: number;
  };
  /** Shared data plane URL (defaults to local 127.0.0.1:3002). */
  dataPlaneUrl: string;
  /** Tick interval in ms; production = 1hr, local dev usually shorter. */
  tickIntervalMs: number;
  /** Reflection runs every N ticks. Default 4. */
  reflectEveryNTicks: number;
  /**
   * Whether to attempt OpenRouter calls. If false, executors fall back to
   * deterministic logic. Useful in CI / when key is a placeholder.
   */
  reasoningEnabled: boolean;
}

export function loadConfig(): AgentConfig {
  const fips = readNumber('STATE_FIPS', 25); // default MA for solo dev
  const state = lookupStateByFips(fips);
  if (!state) {
    throw new Error(`unknown FIPS code: ${fips}`);
  }

  const mcpServerPort = readNumber('MCP_SERVER_PORT', 7100);
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const reasoningEnabled =
    !!openrouterKey &&
    openrouterKey !== 'sk-or-v1-PLACEHOLDER' &&
    process.env.REASONING_ENABLED !== '0';

  return {
    state,
    axl: {
      apiUrl: readString('AXL_API_URL', 'http://127.0.0.1:9002'),
    },
    mcp: {
      serverPort: mcpServerPort,
      serverEndpoint: `http://127.0.0.1:${mcpServerPort}/mcp`,
      routerUrl: readString('MCP_ROUTER_URL', 'http://127.0.0.1:9003'),
      serviceName: readString('MCP_SERVICE_NAME', 'treasurer'),
    },
    a2a: {
      serverPort: readNumber('A2A_SERVER_PORT', 9004),
    },
    dataPlaneUrl: readString('DATA_PLANE_URL', 'http://127.0.0.1:3002'),
    tickIntervalMs: readNumber('TICK_INTERVAL_MS', 30_000),
    reflectEveryNTicks: readNumber('REFLECT_EVERY_N_TICKS', 4),
    reasoningEnabled,
  };
}

/** Used in errors and logs. */
export function describeAgent(cfg: AgentConfig): string {
  return `${cfg.state.abbr} (FIPS ${cfg.state.fips}, ${cfg.state.tier})`;
}

// Suppress an unused-export warning if readRequiredString isn't used yet.
void readRequiredString;
