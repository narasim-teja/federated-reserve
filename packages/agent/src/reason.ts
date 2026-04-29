/**
 * OpenRouter reasoning client.
 *
 * Per CLAUDE.md / TECHNICAL.md: all LLM calls route through OpenRouter
 * (OpenAI-compatible chat completions). Never the Anthropic SDK directly.
 *
 * Separation of concerns:
 *   - **Preset** (configured at openrouter.ai/settings/presets) — picks the
 *     *model* (Opus 4.7 for deep, Haiku 4.5 for observer) and *sampling
 *     parameters* (temperature, max_tokens). That's it.
 *   - **System prompt** — defined in code in `system-prompts.ts`. Lives in
 *     git, evolves with the codebase, baked per agent at startup.
 *   - **User message** — situational context (which proposal, current
 *     treasury, recent indicators) built per call.
 *
 * Two preset slugs are read from env:
 *   OPENROUTER_PRESET_DEEP       (Claude Opus tier, for the 8 deep states)
 *   OPENROUTER_PRESET_OBSERVER   (Claude Haiku tier, for the other 42)
 *
 * Either form is accepted: bare slug ("state-treasurer-deep") or full
 * ("@preset/state-treasurer-deep"); we normalize.
 */

import type { StateTier } from '@federated-reserve/shared';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ReasoningRequest {
  /** Caller picks tier; we resolve to the right preset env var. */
  tier: StateTier;
  /** Code-defined system prompt; prepended to messages as `role: "system"`. */
  system: string;
  /** User-side messages — situational context for this specific decision. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional response-format override; preset's default usually fine. */
  responseFormat?: 'text' | 'json_object';
  /** Per-call sampling override (rare — preset usually authoritative). */
  temperature?: number;
  /** Per-call max tokens override (rare — preset usually authoritative). */
  maxTokens?: number;
  /** Abort signal so callers can cancel. */
  signal?: AbortSignal;
}

export interface ReasoningResponse {
  text: string;
  /** Raw OpenRouter response for debugging. */
  raw: unknown;
  /** Token usage when reported. */
  usage?: { prompt: number; completion: number; total: number };
  /** Preset slug actually invoked (post-normalization). */
  presetUsed: string;
  /** Resolved model OpenRouter says it served (preset-bound or override). */
  modelUsed?: string;
  /** Wallclock ms. */
  latencyMs: number;
}

export class ReasoningError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'ReasoningError';
  }
}

interface ResolvedPresets {
  deep: string;
  observer: string;
}

function normalizePreset(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('OpenRouter preset is empty');
  if (trimmed.startsWith('@preset/')) return trimmed;
  return `@preset/${trimmed}`;
}

function loadPresets(): ResolvedPresets {
  const deep = process.env.OPENROUTER_PRESET_DEEP;
  const observer = process.env.OPENROUTER_PRESET_OBSERVER;
  if (!deep) {
    throw new Error(
      'OPENROUTER_PRESET_DEEP not set. Configure a preset at https://openrouter.ai/settings/presets and set the slug in .env.local.',
    );
  }
  if (!observer) {
    throw new Error('OPENROUTER_PRESET_OBSERVER not set.');
  }
  return { deep: normalizePreset(deep), observer: normalizePreset(observer) };
}

function loadApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === 'sk-or-v1-PLACEHOLDER') {
    throw new Error('OPENROUTER_API_KEY missing or placeholder. Set in .env.local.');
  }
  return key;
}

interface OpenRouterChoice {
  message?: { content?: string };
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DEFAULT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      // Retryable
      if (attempt === DEFAULT_RETRY_DELAYS_MS.length) return res;
      const body = await res.text();
      console.warn(
        `[reason] retryable ${res.status} from OpenRouter (attempt ${attempt + 1}); body=${body.slice(0, 200)}`,
      );
    } catch (err) {
      lastErr = err;
      if (attempt === DEFAULT_RETRY_DELAYS_MS.length) throw err;
    }
    await new Promise((r) => setTimeout(r, DEFAULT_RETRY_DELAYS_MS[attempt]));
  }
  throw lastErr ?? new Error('unreachable');
}

export class Reasoner {
  private readonly apiKey: string;
  private readonly presets: ResolvedPresets;

  constructor() {
    this.apiKey = loadApiKey();
    this.presets = loadPresets();
  }

  presetForTier(tier: StateTier): string {
    // 'federal' tier maps to the deep preset — Fed/Treasury reasoning
    // benefits from Opus-tier capability for rate-setting + transfer
    // gating, even though they're not state agents.
    if (tier === 'observer') return this.presets.observer;
    return this.presets.deep;
  }

  async reason(req: ReasoningRequest): Promise<ReasoningResponse> {
    const preset = this.presetForTier(req.tier);
    const t0 = performance.now();

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: req.system },
      ...req.messages,
    ];
    const body: Record<string, unknown> = {
      model: preset,
      messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    const res = await postWithRetry(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        // Optional metadata; OpenRouter shows these on dashboards.
        'http-referer': 'https://federatedreserve.app',
        'x-title': 'Federated Reserve',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ReasoningError(`OpenRouter ${res.status}: ${text.slice(0, 500)}`, res.status, text);
    }

    let parsed: OpenRouterResponse;
    try {
      parsed = JSON.parse(text) as OpenRouterResponse;
    } catch (err) {
      throw new ReasoningError(`OpenRouter response not JSON: ${(err as Error).message}`);
    }

    const completion = parsed.choices?.[0]?.message?.content;
    if (typeof completion !== 'string') {
      throw new ReasoningError('OpenRouter response missing choices[0].message.content');
    }

    const latencyMs = Math.round(performance.now() - t0);
    return {
      text: completion,
      raw: parsed,
      usage: parsed.usage
        ? {
            prompt: parsed.usage.prompt_tokens ?? 0,
            completion: parsed.usage.completion_tokens ?? 0,
            total: parsed.usage.total_tokens ?? 0,
          }
        : undefined,
      presetUsed: preset,
      modelUsed: parsed.model,
      latencyMs,
    };
  }

  /**
   * Convenience: reason and parse the result as JSON, asking the preset to
   * return JSON via response_format. Throws if parsing fails.
   */
  async reasonJson<T>(req: Omit<ReasoningRequest, 'responseFormat'>): Promise<{
    value: T;
    response: ReasoningResponse;
  }> {
    const response = await this.reason({ ...req, responseFormat: 'json_object' });
    try {
      return { value: JSON.parse(response.text) as T, response };
    } catch (err) {
      throw new ReasoningError(
        `failed to parse JSON from completion: ${(err as Error).message}\n--- raw text ---\n${response.text.slice(0, 500)}`,
      );
    }
  }
}

let cached: Reasoner | null = null;
/**
 * Lazy singleton; first call requires env vars. Tests can construct their
 * own `Reasoner` directly to bypass.
 */
export function getReasoner(): Reasoner {
  if (!cached) cached = new Reasoner();
  return cached;
}
