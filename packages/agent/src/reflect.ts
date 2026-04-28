/**
 * Reflection loop.
 *
 * Every Nth tick, the agent reads its recent log entries (broadcasts sent,
 * indicators received, negotiations completed) and asks the reasoner for a
 * 2-3 sentence summary of "what changed in my position and what I should
 * watch for next." The summary is appended back to the log as a
 * `kind: "reflection"` entry, surfaced in the eventual frontend, and read
 * by the next reflection pass to maintain continuity.
 *
 * If reasoning is disabled (no OpenRouter key) we still emit a
 * deterministic stub reflection — the loop must keep working in CI / cold
 * starts where the LLM isn't reachable.
 */

import type { Reasoner } from './reason.ts';
import type { TickDeps } from './tick.ts';

const REFLECTION_PROMPT_INTRO =
  'Review your recent activity and reflect briefly — 2-3 sentences covering: ' +
  '(1) what new information arrived since the last reflection, (2) what your position looks like now, ' +
  '(3) what you should watch for next. Plain prose. Do not return JSON.';

export async function runReflection(deps: TickDeps): Promise<void> {
  const { cfg, memory, state } = deps;

  const recent = await memory.recentLog(20);
  const contextText = buildReflectionContext(deps, recent);

  let summary: string;
  if (deps.reasoner && cfg.reasoningEnabled) {
    summary = await runWithReasoner(deps.reasoner, cfg.state.tier, deps.systemPrompt, contextText);
  } else {
    summary = stubReflection(deps);
  }

  await memory.appendLog({
    kind: 'reflection',
    at: new Date().toISOString(),
    summary,
    details: {
      tick: state.tickCount,
      reasoning_used: !!(deps.reasoner && cfg.reasoningEnabled),
      log_entries_considered: recent.length,
    },
  });
  console.log(`[${cfg.state.abbr}] reflection (tick ${state.tickCount}): ${summary}`);
}

async function runWithReasoner(
  reasoner: Reasoner,
  tier: 'deep' | 'observer',
  system: string,
  contextText: string,
): Promise<string> {
  const response = await reasoner.reason({
    tier,
    system,
    messages: [
      {
        role: 'user',
        content: `${REFLECTION_PROMPT_INTRO}\n\n${contextText}`,
      },
    ],
  });
  return response.text.trim();
}

function buildReflectionContext(
  deps: TickDeps,
  recent: Awaited<ReturnType<typeof deps.memory.recentLog>>,
): string {
  const { state } = deps;
  const snapshotText = state.ownSnapshot
    ? Object.entries(state.ownSnapshot.indicators)
        .map(([k, v]) => `  - ${k}: ${v?.value} (${v?.source}, observed ${v?.observation_date})`)
        .join('\n')
    : '  (no snapshot loaded yet)';

  const treasuryText = state.composition.map((c) => `  - ${c.asset}: ${c.balance}`).join('\n');

  const logText =
    recent.length === 0
      ? '  (no log entries yet)'
      : recent.map((e) => `  - [${e.at}] ${e.kind}: ${e.summary}`).join('\n');

  return [
    `Tick: ${state.tickCount}`,
    `Reserve ratio: ${state.reserveRatio}`,
    `Treasury composition:\n${treasuryText}`,
    `Latest indicators:\n${snapshotText}`,
    `Recent activity (newest first):\n${logText}`,
  ].join('\n\n');
}

function stubReflection(deps: TickDeps): string {
  const { cfg, state } = deps;
  const indCount = state.receivedIndicators.length;
  return (
    `[${cfg.state.abbr}] tick ${state.tickCount} reflection: reasoning disabled (no OpenRouter key). ` +
    `Position unchanged; reserve ratio ${state.reserveRatio}; ${indCount} peer indicators on file.`
  );
}
