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
 *
 * Cost guard: we hash the (recent log + reserve + tick-bucket) inputs and
 * skip the LLM round-trip when nothing has changed since the previous
 * reflection. Idle agents produce identical hashes for many ticks in a
 * row — at 50 agents × 3 days this saves the bulk of reflection spend.
 */

import { createHash } from 'node:crypto';
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

  // Hash *the inputs that would change a reflection's content* — not the
  // tick number itself (which always changes). The aim is to detect "the
  // agent has nothing new to say" so we can skip the LLM call.
  const inputsHash = computeReflectionHash(deps, recent);
  const unchanged = state.lastReflectionHash === inputsHash;

  let summary: string;
  let usedReasoner = false;
  if (unchanged) {
    summary = unchangedReflection(deps);
  } else if (deps.reasoner && cfg.reasoningEnabled) {
    summary = await runWithReasoner(deps.reasoner, cfg.state.tier, deps.systemPrompt, contextText);
    usedReasoner = true;
    state.lastReflectionHash = inputsHash;
  } else {
    summary = stubReflection(deps);
    state.lastReflectionHash = inputsHash;
  }

  await memory.appendLog({
    kind: 'reflection',
    at: new Date().toISOString(),
    summary,
    details: {
      tick: state.tickCount,
      reasoning_used: usedReasoner,
      log_entries_considered: recent.length,
      skipped_unchanged: unchanged,
    },
  });
  deps.telemetry?.reportReflection({
    state_fips: cfg.state.fips,
    state_abbr: cfg.state.abbr,
    summary,
    tick: state.tickCount,
  });
  console.log(
    `[${cfg.state.abbr}] reflection (tick ${state.tickCount})${unchanged ? ' [skipped LLM — inputs unchanged]' : ''}: ${summary}`,
  );
}

async function runWithReasoner(
  reasoner: Reasoner,
  tier: import('@federated-reserve/shared').StateTier,
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
    // Reflections are ~2-3 sentences; cap so the model can't blow tokens.
    maxTokens: 200,
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

/**
 * Inputs that meaningfully change a reflection. We deliberately exclude the
 * tick counter and timestamps — pure "another tick fired with nothing
 * new" should hash identically.
 *
 * `kind+summary` is used for log entries (cheap, captures the meaningful
 * change) and we exclude reflection entries themselves so we don't loop
 * over our own output.
 */
function computeReflectionHash(
  deps: TickDeps,
  recent: Awaited<ReturnType<typeof deps.memory.recentLog>>,
): string {
  const { state } = deps;
  const logFingerprint = recent
    .filter((e) => e.kind !== 'reflection')
    .map((e) => `${e.kind}|${e.summary}`)
    .join('\n');
  const treasuryFingerprint = state.composition
    .map((c) => `${c.asset}=${c.balance}`)
    .join(',');
  const snapshotFingerprint = state.ownSnapshot
    ? Object.entries(state.ownSnapshot.indicators)
        .map(([k, v]) => `${k}=${v?.value}@${v?.observation_date}`)
        .join(',')
    : '';
  const payload = [
    `reserve=${state.reserveRatio}`,
    `treasury=${treasuryFingerprint}`,
    `snapshot=${snapshotFingerprint}`,
    `log=${logFingerprint}`,
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function unchangedReflection(deps: TickDeps): string {
  const { cfg, state } = deps;
  return (
    `[${cfg.state.abbr}] tick ${state.tickCount}: no material change since last reflection. ` +
    `Reserve ratio ${state.reserveRatio}; ${state.receivedIndicators.length} peer indicators on file. Holding posture.`
  );
}

function stubReflection(deps: TickDeps): string {
  const { cfg, state } = deps;
  const indCount = state.receivedIndicators.length;
  return (
    `[${cfg.state.abbr}] tick ${state.tickCount} reflection: reasoning disabled (no OpenRouter key). ` +
    `Position unchanged; reserve ratio ${state.reserveRatio}; ${indCount} peer indicators on file.`
  );
}
