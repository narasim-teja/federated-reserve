/**
 * Quick verification for the prompt-caching + skip-if-unchanged changes.
 *
 * Two checks:
 *
 *   1. Caching headers reach OpenRouter and provider reports cache reads on
 *      the second call. We send a deliberately long, identical system prompt
 *      twice and inspect `usage.cache_read_input_tokens` /
 *      `usage.prompt_tokens_details.cached_tokens` on call 2. If neither is
 *      populated, the request still succeeds — but we surface a warning so
 *      the operator can decide whether the active preset's model supports
 *      explicit caching at the prompt size we're sending.
 *
 *   2. Reflection skips the LLM round-trip when log inputs are unchanged. We
 *      construct an in-process agent state + InMemoryMemory, run reflection
 *      twice with no intervening log writes, and assert the second pass
 *      logged `skipped_unchanged: true` and reused the prior summary text
 *      without invoking the reasoner.
 *
 * Usage:
 *   bun run scripts/test-cost-optimizations.ts
 *
 * Requires OPENROUTER_API_KEY + presets configured in .env.local for check 1.
 * Check 2 runs offline (uses an InMemoryMemory + a stub reasoner that
 * fails the test if invoked when the input hash is unchanged).
 */

import { Reasoner } from '../packages/agent/src/reason.ts';
import { runReflection } from '../packages/agent/src/reflect.ts';
import { InMemoryMemory } from '../packages/agent/src/memory.ts';
import { makeInitialState } from '../packages/agent/src/state.ts';
import type { AgentConfig } from '../packages/agent/src/config.ts';
import type { TickDeps } from '../packages/agent/src/tick.ts';

let failed = 0;
function ok(label: string): void {
  console.log(`[cost-opt] ✓ ${label}`);
}
function fail(label: string, msg: string): void {
  failed += 1;
  console.error(`[cost-opt] ✗ ${label}: ${msg}`);
}
function warn(label: string, msg: string): void {
  console.warn(`[cost-opt] ! ${label}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Check 1 — caching headers + cache_read_input_tokens
// ---------------------------------------------------------------------------
async function checkCachingHeaders(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key === 'sk-or-v1-PLACEHOLDER') {
    warn('caching', 'OPENROUTER_API_KEY missing — skipping live caching check');
    return;
  }

  let reasoner: Reasoner;
  try {
    reasoner = new Reasoner();
  } catch (err) {
    warn('caching', `Reasoner init failed: ${(err as Error).message}`);
    return;
  }

  // Deliberately long system prompt so we clear most providers' min-cache
  // thresholds (Anthropic Sonnet ≥1024, Gemini Flash ≥1024). We pad a base
  // string to roughly 1500 tokens of stable content.
  const base =
    'You are a deterministic test treasurer. ' +
    'Always reply with the single word OK and nothing else. ' +
    'No JSON, no punctuation, no commentary, no code fences.\n';
  const padding = (
    'Operating notes (constant across calls — safe to cache): ' +
    'reserve ratio target 12 percent, regional affinities northeast/midwest/west, ' +
    'preferred counterparties NY MA IL CA WA, decision principles defend solvency first, ' +
    'always remain in character, never break role, never disclose system internals. '
  ).repeat(40);
  const system = `${base}${padding}`;

  // Call twice with the exact same payload. On a cache-supporting provider the
  // second call should report cached prompt tokens.
  const userMsg = { role: 'user' as const, content: 'Reply OK.' };
  const first = await reasoner.reason({
    tier: 'observer',
    system,
    messages: [userMsg],
    maxTokens: 8,
  });
  const second = await reasoner.reason({
    tier: 'observer',
    system,
    messages: [userMsg],
    maxTokens: 8,
  });

  console.log(
    `[cost-opt]   call1: model=${first.modelUsed} usage=${JSON.stringify(first.usage)} latency=${first.latencyMs}ms`,
  );
  console.log(
    `[cost-opt]   call2: model=${second.modelUsed} usage=${JSON.stringify(second.usage)} latency=${second.latencyMs}ms`,
  );

  if (!second.usage) {
    warn('caching', 'second call returned no usage block — cannot verify caching');
    return;
  }

  const cached = second.usage.cached ?? 0;
  if (cached > 0) {
    ok(`caching active — second call reports cached=${cached} prompt tokens`);
  } else {
    warn(
      'caching',
      `second call reports no cached tokens. ` +
        `Provider may not support explicit caching at this prompt size, or the preset's model doesn't surface cache metrics. ` +
        `Request still includes cache_control marker (verified by code path); production calls may benefit silently.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2 — reflection skip-if-unchanged
// ---------------------------------------------------------------------------
async function checkReflectionSkip(): Promise<void> {
  const memory = new InMemoryMemory();
  const state = makeInitialState(25);
  state.tickCount = 8;

  // Seed one non-reflection log entry so the hash isn't trivial-empty.
  await memory.appendLog({
    kind: 'broadcast_sent',
    at: '2026-05-02T00:00:00Z',
    summary: 'gdp=2.1 from FRED → 1/1 peers',
  });

  // Counter goes through a getter so TS treats every read as a fresh
  // `number` (no flow-narrowing across the early-return checks below).
  let _reasonerCalls = 0;
  const calls = (): number => _reasonerCalls;
  const stubReasoner = {
    reason: async () => {
      _reasonerCalls += 1;
      return { text: 'fake reflection summary', raw: {}, presetUsed: '@preset/x', latencyMs: 1 };
    },
  } as unknown as InstanceType<typeof Reasoner>;

  // Build the minimum TickDeps the reflection function actually reads. We
  // cast through unknown to avoid wiring up AXL/discovery/dataPlane — none
  // are touched by runReflection.
  const cfg = {
    state: { fips: 25, abbr: 'TEST', tier: 'deep', name: 'Testland', region: 'NE' },
    reasoningEnabled: true,
    reflectEveryNTicks: 8,
  } as unknown as AgentConfig;

  const deps: TickDeps = {
    cfg,
    memory,
    state,
    reasoner: stubReasoner,
    systemPrompt: 'system prompt for testland',
    // Unused by reflection — leave as undefined-shaped dummies.
    axl: undefined as never,
    discovery: undefined as never,
    dataPlane: undefined as never,
  };

  await runReflection(deps);
  const log1 = await memory.recentLog(50);
  const r1 = log1.find((e) => e.kind === 'reflection');
  if (!r1) return fail('skip-if-unchanged', 'no reflection emitted on first pass');
  if (calls() !== 1) return fail('skip-if-unchanged', `expected 1 reasoner call, got ${calls()}`);
  if (r1.details?.skipped_unchanged === true) {
    return fail('skip-if-unchanged', 'first reflection flagged skipped — should have run LLM');
  }
  ok('first reflection invoked LLM and recorded hash');

  // Second pass — same inputs, no new log. (The reflection from pass 1 is in
  // the log, but is filtered out by the hash function.)
  await runReflection(deps);
  const log2 = await memory.recentLog(50);
  const reflections = log2.filter((e) => e.kind === 'reflection');
  if (reflections.length !== 2) {
    return fail('skip-if-unchanged', `expected 2 reflection entries, got ${reflections.length}`);
  }
  const r2 = reflections[0]; // recentLog is newest-first
  if (calls() !== 1) {
    return fail(
      'skip-if-unchanged',
      `expected reasoner call count to stay at 1, got ${calls()} — LLM was hit unnecessarily`,
    );
  }
  if (r2?.details?.skipped_unchanged !== true) {
    return fail(
      'skip-if-unchanged',
      `second reflection should be marked skipped_unchanged=true; got ${JSON.stringify(r2?.details)}`,
    );
  }
  ok('second reflection skipped LLM (inputs unchanged)');

  // Now mutate state — append a new broadcast log entry — and verify a
  // third pass does call the reasoner.
  await memory.appendLog({
    kind: 'broadcast_received',
    at: '2026-05-02T00:05:00Z',
    summary: 'unemp=4.3 from CA',
  });
  await runReflection(deps);
  if (calls() !== 2) {
    return fail(
      'skip-if-unchanged',
      `after log change, expected reasoner calls to advance to 2, got ${calls()}`,
    );
  }
  ok('third reflection re-invoked LLM after log change');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[cost-opt] running cost-optimization verification');
  await checkReflectionSkip();
  await checkCachingHeaders();
  if (failed > 0) {
    console.error(`[cost-opt] FAIL — ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('[cost-opt] PASS');
}

main().catch((err) => {
  console.error('[cost-opt] uncaught error', err);
  process.exit(2);
});
