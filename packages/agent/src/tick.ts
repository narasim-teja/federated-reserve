/**
 * Tick loop.
 *
 * Phase 2: each tick the agent
 *   1. polls its own state's snapshot from the data plane
 *   2. picks the freshest indicator and broadcasts it to the discovered mesh
 *   3. updates `state.ownSnapshot` and persists state to memory
 *   4. on every Nth tick, kicks off a reflection pass (handled by reflect.ts)
 *
 * If the data plane is unreachable or hasn't loaded our state's snapshot
 * yet, we skip the broadcast — the project's non-goals say "never fake data."
 */

import { randomUUID } from 'node:crypto';
import {
  type ShockEvent,
  type StateSnapshot,
  loadDeployments,
  lookupStateByFips,
  pickBroadcastIndicator,
} from '@federated-reserve/shared';
import type { Address } from 'viem';
import type { AxlClient } from './axl-client.ts';
import { broadcastFedRate, broadcastIndicator } from './broadcast.ts';
import type { ChainReader } from './chain-reader.ts';
import type { AgentConfig } from './config.ts';
import type { DataPlaneClient } from './data-plane-client.ts';
import type { MeshDiscovery } from './discovery.ts';
import type { SwapExecutor } from './execute.ts';
import type { AgentMemory } from './memory.ts';
import type { ObserverTelemetry } from './observer-client.ts';
import type { OgReader } from './og-reader.ts';
import type { Reasoner } from './reason.ts';
import { runReflection } from './reflect.ts';
import { type AgentState, applyChainBalances, applyOgStatus } from './state.ts';

export interface TickDeps {
  cfg: AgentConfig;
  axl: AxlClient;
  discovery: MeshDiscovery;
  dataPlane: DataPlaneClient;
  memory: AgentMemory;
  state: AgentState;
  reasoner?: Reasoner;
  /** System prompt baked at startup; passed to the reasoner on every call. */
  systemPrompt: string;
  telemetry?: ObserverTelemetry;
  /** Phase 5 — Unichain Sepolia balance reader (USDC, state token, bonds). */
  chainReader?: ChainReader;
  /** Phase 5 — 0G Galileo status reader (native + iNFT tokenURI). */
  ogReader?: OgReader;
  /** Optional swap executor; reused for the autonomous rebalance policy. */
  swapExecutor?: SwapExecutor;
}

export function startTickLoop(deps: TickDeps): { stop: () => void } {
  const { cfg, state, memory, dataPlane } = deps;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const isFederal = cfg.state.tier === 'federal';
  const isFed = cfg.state.abbr === 'FED';
  const fedRateBroadcastEveryN = Number(process.env.FED_RATE_BROADCAST_EVERY_N ?? '4');
  // FED also drives the NOAA-shock injector. We pull active shocks every
  // shockSweepEveryN ticks, dedup against recently injected event_ids, and
  // fan-out `coordinate-shock-response` over A2A to the affected leaves.
  const shockSweepEveryN = Number(process.env.SHOCK_SWEEP_EVERY_N ?? '6');
  const recentlyInjectedShocks = new Set<string>();

  // Onchain refresh cadence — every Nth tick. Default 5 ≈ 2.5min @ 30s ticks.
  const chainRefreshEveryN = Number(process.env.CHAIN_REFRESH_EVERY_N_TICKS ?? '5');
  const ogRefreshEveryN = Number(process.env.OG_REFRESH_EVERY_N_TICKS ?? '10');
  // Autonomous rebalance — fire a real Trading-API swap if the live reserve
  // ratio has drifted off-target by `bps`. Conservative defaults; off
  // entirely if AUTO_REBALANCE_ENABLED=0 or if we lack a swap executor.
  const autoRebalanceEnabled =
    process.env.AUTO_REBALANCE_ENABLED !== '0' && !!deps.swapExecutor;
  const targetReserveRatio = Number(process.env.AUTO_REBALANCE_TARGET ?? '0.20');
  const driftBps = Number(process.env.AUTO_REBALANCE_DRIFT_BPS ?? '500'); // 5%
  const minSwapUsdc = BigInt(process.env.AUTO_REBALANCE_MIN_USDC ?? '50000000'); // 50 USDC
  const maxSwapUsdc = BigInt(process.env.AUTO_REBALANCE_MAX_USDC ?? '500000000'); // 500 USDC
  const autoCooldownTicks = Number(process.env.AUTO_REBALANCE_COOLDOWN_TICKS ?? '12');

  const tick = async () => {
    if (stopped) return;
    state.tickCount += 1;
    const tickNo = state.tickCount;

    try {
      if (isFederal) {
        if (isFed && tickNo % fedRateBroadcastEveryN === 0) {
          await broadcastFedRateTick(deps, tickNo);
        }
        if (isFed && tickNo % shockSweepEveryN === 0) {
          await sweepNoaaShocksAndFanOut(deps, tickNo, recentlyInjectedShocks);
        }
      } else {
        const snapshot = await dataPlane.snapshot(cfg.state.fips);
        if (!snapshot) {
          console.log(
            `[${cfg.state.abbr}] tick ${tickNo}: no snapshot from data plane yet — skipping broadcast`,
          );
        } else {
          state.ownSnapshot = snapshot;
          await broadcastFromSnapshot(deps, snapshot, tickNo);
        }
      }

      // Onchain reads — every Nth tick or on cold start (when balances absent).
      if (deps.chainReader && (state.chainBalances == null || tickNo % chainRefreshEveryN === 0)) {
        await refreshOnchainBalances(deps, tickNo);
      }
      if (deps.ogReader && (state.ogStatus == null || tickNo % ogRefreshEveryN === 0)) {
        await refreshOgStatus(deps, tickNo);
      }

      // Autonomous rebalance — only if reads succeeded and the agent has a
      // swap executor wired. Off entirely on FED/TRS (no state token).
      if (
        autoRebalanceEnabled &&
        !isFederal &&
        deps.chainReader &&
        deps.swapExecutor &&
        state.chainBalances
      ) {
        await maybeAutoRebalance(deps, tickNo, {
          targetReserveRatio,
          driftBps,
          minSwapUsdc,
          maxSwapUsdc,
          cooldownTicks: autoCooldownTicks,
        });
      }

      // Reflection cadence — log-based summary using OpenRouter (when enabled).
      if (tickNo % cfg.reflectEveryNTicks === 0) {
        await runReflection(deps).catch((err: unknown) => {
          console.warn(`[${cfg.state.abbr}] reflection failed: ${String(err)}`);
        });
      }

      // Persist state after the tick (snapshot + tickCount changed).
      await memory.saveState(state);
    } catch (err) {
      console.error(`[${cfg.state.abbr}] tick ${tickNo} failed:`, err);
    } finally {
      if (!stopped) timer = setTimeout(tick, cfg.tickIntervalMs);
    }
  };

  // First tick fires after a short delay so peers have time to discover us.
  timer = setTimeout(tick, 5_000);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Phase 4 — Fed agent's tick-loop fan-out. Picks a rate from a small
 * deterministic schedule (so demos look intentional), or, if the
 * reasoner is wired in, asks the LLM for a rate decision based on
 * received state telemetry.
 */
async function broadcastFedRateTick(deps: TickDeps, tickNo: number): Promise<void> {
  const { cfg, axl, discovery, memory, state, reasoner } = deps;

  // Minimal default cycle: walk a 4-step rate path so the demo shows
  // movement even without the LLM. Override the per-tick rate via env.
  const fixedSchedule = [525, 500, 475, 450];
  const idx = Math.floor(tickNo / 4) % fixedSchedule.length;
  let rateBps = fixedSchedule[idx] ?? 525;
  let rationale = `Quarterly cadence (deterministic): tick ${tickNo} → ${rateBps}bps.`;

  if (reasoner && cfg.reasoningEnabled) {
    try {
      const recentIndicators = state.receivedIndicators.slice(-12).map((r) => ({
        from_fips: r.state_fips,
        kind: r.indicator,
        value: r.value,
        date: r.timestamp,
      }));
      const prompt = [
        'Skill: announce_fed_rate. You are the Federal Reserve. Set the federal funds rate.',
        `Recent indicators received from states: ${JSON.stringify(recentIndicators)}`,
        `Last announced rate: ${state.receivedFedRates?.[state.receivedFedRates.length - 1]?.rateBps ?? 'none'}.`,
        'Respond ONLY with JSON: { "rate_bps": <int 0..1000>, "rationale": "<one short sentence>" }.',
        'Move at most 50bps from prior rate. Stay defensive: rising unemployment → cut; rising income/inflation proxies → hold or hike.',
      ].join('\n');
      const result = await reasoner.reasonJson<{ rate_bps: number; rationale: string }>({
        tier: cfg.state.tier,
        system: deps.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      });
      rateBps = result.value.rate_bps;
      rationale = result.value.rationale;
    } catch (err) {
      console.warn(`[FED] rate reasoner failed (${String(err)}); using deterministic schedule`);
    }
  }

  const input = {
    rate_bps: rateBps,
    effective: new Date().toISOString(),
    rationale,
  };
  const results = await broadcastFedRate(cfg, axl, discovery, input);
  const ok = results.filter((r) => r.ok).length;
  await memory.appendLog({
    kind: 'broadcast_sent',
    at: new Date().toISOString(),
    summary: `fed_rate=${rateBps}bps → ${ok}/${results.length} peers`,
    details: { tick: tickNo, input, results },
  });
}

/**
 * Phase 4+ — FED's NOAA shock injector.
 *
 * Pulls active NOAA shocks from the data plane, picks the highest-severity
 * unique event_ids we haven't injected before, and fan-outs
 * `coordinate-shock-response` A2A messages to each affected state.
 * Deduplication is per-process (in-memory set bounded to last 64 ids).
 */
async function sweepNoaaShocksAndFanOut(
  deps: TickDeps,
  tickNo: number,
  recently: Set<string>,
): Promise<void> {
  const { cfg, axl, discovery, memory, dataPlane } = deps;
  const events = await dataPlane.shocks(20);
  if (events.length === 0) {
    console.log(`[FED] tick ${tickNo}: no active NOAA shocks to inject`);
    return;
  }

  // Map of state pubkey for the affected states. We only fan out to peers
  // whose abbr we can resolve via FIPS → state lookup AND who appear in
  // discovery.knownPeers().
  const knownPubkeys = discovery.knownPeers();
  if (knownPubkeys.length === 0) {
    console.log(`[FED] tick ${tickNo}: no peers discovered yet — skipping shock injection`);
    return;
  }

  // Group events by FIPS so we send one shock signal per affected state
  // (most-severe representative event chosen per state).
  const byFips = new Map<number, ShockEvent>();
  for (const ev of events) {
    const fresh = !recently.has(ev.event_id);
    if (!fresh) continue;
    const cur = byFips.get(ev.state_fips);
    if (!cur || ev.severity > cur.severity) {
      byFips.set(ev.state_fips, ev);
    }
  }

  if (byFips.size === 0) {
    console.log(`[FED] tick ${tickNo}: all active shocks already injected — quiet sweep`);
    return;
  }

  const injected: string[] = [];
  const failed: string[] = [];
  for (const [fips, event] of byFips) {
    const state = lookupStateByFips(fips);
    if (!state) continue;
    const targetPub = await resolvePeerPubkeyByAbbr(deps, state.abbr);
    if (!targetPub) {
      console.log(
        `[FED] shock fan-out skip: no AgentCard pubkey resolved for ${state.abbr} (FIPS ${fips})`,
      );
      continue;
    }
    if (!knownPubkeys.includes(targetPub)) {
      console.log(`[FED] shock fan-out skip: ${state.abbr} pubkey not in mesh discovery yet`);
      continue;
    }
    const body = {
      jsonrpc: '2.0' as const,
      id: randomUUID(),
      method: 'message/send' as const,
      params: {
        message: {
          kind: 'message' as const,
          role: 'user' as const,
          messageId: randomUUID(),
          parts: [
            {
              kind: 'data' as const,
              data: {
                skill: 'coordinate-shock-response',
                initiator_fips: cfg.state.fips,
                shock_kind: event.shock_kind,
                affected_fips: [event.state_fips],
                severity: event.severity,
                proposed_action: `NOAA-driven shock signal: ${event.event_type} affecting ${state.abbr} (severity ${event.severity}/10). FED requests coordinated reserve posture; affected state should commit pro-rata to gulf-disaster-pool / climate-exposed peers.`,
              },
            },
          ],
        },
      },
    };
    try {
      const response = (await axl.callRemoteA2a(targetPub, body)) as {
        result?: {
          status?: {
            state?: string;
            message?: { parts?: Array<{ kind?: string; data?: { kind?: string } }> };
          };
        };
      };
      const statusState = response.result?.status?.state;
      const contribution = response.result?.status?.message?.parts?.find(
        (part) => part.kind === 'data',
      )?.data;
      if (statusState !== 'completed' || !contribution?.kind) {
        failed.push(`${state.abbr}/${event.event_type}:state=${statusState ?? 'unknown'}`);
        continue;
      }
      injected.push(`${state.abbr}/${event.event_type}@sev${event.severity}`);
      recently.add(event.event_id);
      deps.telemetry?.reportShockInjected({
        state_fips: event.state_fips,
        shock_kind: event.shock_kind,
        event_type: event.event_type,
        severity: event.severity,
        source: 'NOAA',
      });
    } catch (err) {
      failed.push(`${state.abbr}/${event.event_type}`);
      console.warn(`[FED] shock fan-out FAILED for ${state.abbr}: ${(err as Error).message}`);
    }
  }
  // Bound the dedup set so it doesn't grow forever.
  if (recently.size > 64) {
    const drop = recently.size - 48;
    let i = 0;
    for (const id of recently) {
      if (i++ >= drop) break;
      recently.delete(id);
    }
  }
  console.log(
    `[FED] shock injection tick ${tickNo}: ${injected.length}/${byFips.size} affected states notified — ${injected.join(', ')}${failed.length ? `; failed=${failed.join(', ')}` : ''}`,
  );
  await memory.appendLog({
    kind: 'broadcast_sent',
    at: new Date().toISOString(),
    summary: `noaa_shock_inject: ${injected.length} states (${injected.join(', ')})`,
    details: { tick: tickNo, source: 'NOAA', injected, failed },
  });
}

/**
 * Resolve an A2A peer pubkey by state abbreviation. We do this by walking
 * the discovery's known peers and fetching each AgentCard once (cached by
 * the consumer). For the local mesh, this is cheap; for production we'd
 * keep an explicit abbr→pubkey map at startup.
 */
const _agentCardCache = new Map<string, { abbr: string | null; ts: number }>();

async function resolvePeerPubkeyByAbbr(deps: TickDeps, abbr: string): Promise<string | null> {
  const { axl, discovery } = deps;
  const peers = discovery.knownPeers();
  for (const peer of peers) {
    const cached = _agentCardCache.get(peer);
    if (cached?.abbr) {
      if (cached.abbr === abbr) return peer;
      continue;
    }
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) continue;
    try {
      const card = (await axl.getRemoteAgentCard(peer)) as { name?: string };
      const name = (card?.name ?? '').toLowerCase();
      // Names look like "Massachusetts State Treasurer" — extract a hint by
      // checking against known state names. Cheap: keep it simple.
      const stateMatch = name.includes('massachusetts')
        ? 'MA'
        : name.includes('california')
          ? 'CA'
          : name.includes('texas')
            ? 'TX'
            : name.includes('new york')
              ? 'NY'
              : name.includes('florida')
                ? 'FL'
                : name.includes('illinois')
                  ? 'IL'
                  : name.includes('washington')
                    ? 'WA'
                    : name.includes('alaska')
                      ? 'AK'
                      : name.includes('federal reserve')
                        ? 'FED'
                        : name.includes('treasury')
                          ? 'TRS'
                          : null;
      _agentCardCache.set(peer, { abbr: stateMatch, ts: Date.now() });
      if (stateMatch === abbr) return peer;
    } catch {
      _agentCardCache.set(peer, { abbr: null, ts: Date.now() });
    }
  }
  return null;
}

async function broadcastFromSnapshot(
  deps: TickDeps,
  snapshot: StateSnapshot,
  tickNo: number,
): Promise<void> {
  const { cfg, axl, discovery, memory } = deps;
  const picked = pickBroadcastIndicator(snapshot);
  if (!picked) {
    console.log(
      `[${cfg.state.abbr}] tick ${tickNo}: snapshot has no indicators yet — skipping broadcast`,
    );
    return;
  }
  const input = {
    state_fips: cfg.state.fips,
    indicator: picked.kind,
    value: picked.obs.value,
    timestamp: picked.obs.observation_date,
    source: picked.obs.source,
  };
  const results = await broadcastIndicator(cfg, axl, discovery, input);
  const ok = results.filter((r) => r.ok).length;
  await memory.appendLog({
    kind: 'broadcast_sent',
    at: new Date().toISOString(),
    summary: `${picked.kind}=${picked.obs.value} from ${picked.obs.source} → ${ok}/${results.length} peers`,
    details: { tick: tickNo, input, results },
  });
}

/** Phase 5 — replace stub composition with real on-chain numbers. */
async function refreshOnchainBalances(deps: TickDeps, tickNo: number): Promise<void> {
  const { cfg, state, memory, chainReader } = deps;
  if (!chainReader) return;
  const before = state.chainBalances?.fetchedAt;
  const next = await chainReader.refresh();
  if (!next) return; // RPC failure already logged inside the reader
  const prevTotal = state.totalValueUsd;
  applyChainBalances(state, next);
  const drift =
    prevTotal === 0 ? 1 : Math.abs(state.totalValueUsd - prevTotal) / prevTotal;
  const stateTokenLine = next.stateToken
    ? `${next.stateToken.symbol}=${trim(next.stateToken.balance)}`
    : 'no-state-token';
  console.log(
    `[${cfg.state.abbr}] tick ${tickNo}: chain refresh @ block ${next.blockNumber}: ` +
      `USDC=${trim(next.usdcBalance)} ${stateTokenLine} bonds=${next.bonds.length} ` +
      `total=$${next.totalNotionalUsd.toFixed(0)} ratio=${(next.liquidReserveRatio * 100).toFixed(1)}%`,
  );
  // Log only on cold-start or when the value moved >1% since last refresh —
  // otherwise the log gets spammy across a long demo.
  if (!before || drift > 0.01) {
    await memory.appendLog({
      kind: 'decision',
      at: next.fetchedAt,
      summary:
        `onchain_balance_refresh @ block ${next.blockNumber}: $${next.totalNotionalUsd.toFixed(0)} ` +
        `(reserve ${(next.liquidReserveRatio * 100).toFixed(1)}%)`,
      details: {
        tick: tickNo,
        wallet: next.walletAddress,
        usdc: next.usdcBalance,
        stateToken: next.stateToken
          ? { symbol: next.stateToken.symbol, balance: next.stateToken.balance }
          : null,
        bonds: next.bonds.map((b) => ({ id: b.bondId, balance: b.balance })),
        totalUsd: next.totalNotionalUsd,
        reserveRatio: next.liquidReserveRatio,
      },
    });
  }
}

async function refreshOgStatus(deps: TickDeps, tickNo: number): Promise<void> {
  const { cfg, state, memory, ogReader } = deps;
  if (!ogReader) return;
  const before = state.ogStatus?.fetchedAt;
  const next = await ogReader.refresh();
  if (!next) return;
  applyOgStatus(state, next);
  console.log(
    `[${cfg.state.abbr}] tick ${tickNo}: 0G refresh @ block ${next.blockNumber}: ` +
      `native=${trim(next.nativeBalance)} 0G ` +
      (next.inft
        ? `iNFT #${next.inft.tokenId} owner=${shortAddr(next.inft.onchainOwner)} ${next.inft.ownerMatches ? '✓' : '✗ MISMATCH'}`
        : 'no-iNFT'),
  );
  if (!before) {
    await memory.appendLog({
      kind: 'decision',
      at: next.fetchedAt,
      summary: `0G read: native=${trim(next.nativeBalance)} 0G; iNFT ${
        next.inft ? `#${next.inft.tokenId}` : 'unminted'
      }`,
      details: {
        tick: tickNo,
        wallet: next.walletAddress,
        native: next.nativeBalance,
        inft: next.inft,
      },
    });
  }
}

interface RebalanceConfig {
  targetReserveRatio: number;
  driftBps: number;
  minSwapUsdc: bigint;
  maxSwapUsdc: bigint;
  cooldownTicks: number;
}

/**
 * Real autonomous rebalance — fires a Trading-API swap when the live reserve
 * ratio (USDC / total notional) drifts off-target by more than `driftBps`.
 *
 *   ratio < target − driftBps → buy USDC: sell `state-token` for USDC
 *   ratio > target + driftBps → buy state-token: sell USDC for `state-token`
 *
 * The swap size is min(|gap| × totalUsd, max), clamped to [min, max]. Skips
 * when the agent has no state-token balance (sell side empty) or zero USDC
 * (buy side empty).
 */
async function maybeAutoRebalance(
  deps: TickDeps,
  tickNo: number,
  cfg: RebalanceConfig,
): Promise<void> {
  const { cfg: agentCfg, state, memory, swapExecutor, telemetry } = deps;
  if (!swapExecutor || !state.chainBalances) return;

  // Cooldown — don't churn swaps every tick.
  if (
    state.lastAutoSwapTick != null &&
    state.lastAutoSwapTick > 0 &&
    tickNo - state.lastAutoSwapTick < cfg.cooldownTicks
  ) {
    return;
  }

  const ratio = state.chainBalances.liquidReserveRatio;
  const targetMin = cfg.targetReserveRatio - cfg.driftBps / 10_000;
  const targetMax = cfg.targetReserveRatio + cfg.driftBps / 10_000;
  if (ratio >= targetMin && ratio <= targetMax) return;

  const stateToken = state.chainBalances.stateToken;
  if (!stateToken) return;

  const deployments = loadDeployments('unichain-sepolia');
  const usdcAddr = deployments.contracts.MockUSDC.address as Address;
  const stAddr = stateToken.address;

  const usdcRaw = BigInt(state.chainBalances.usdcBalanceRaw);
  const stRaw = BigInt(stateToken.balanceRaw);

  let direction: 'buy_usdc' | 'sell_usdc';
  let amountIn: bigint;
  let tokenIn: Address;
  let tokenOut: Address;

  if (ratio < targetMin) {
    // Need more USDC — sell state token. Size the swap to roughly close the
    // gap, but expressed in state-token units (18 decimals; 1 token = $1 par).
    direction = 'buy_usdc';
    const gapUsd = (cfg.targetReserveRatio - ratio) * state.chainBalances.totalNotionalUsd;
    const tokenAmountUsd = clampUsdc(
      BigInt(Math.floor(gapUsd * 1_000_000)),
      cfg.minSwapUsdc,
      cfg.maxSwapUsdc,
    );
    // Convert USDC notional → 18-decimal state-token amount: multiply by 10^12.
    amountIn = tokenAmountUsd * 1_000_000_000_000n;
    tokenIn = stAddr;
    tokenOut = usdcAddr;
    if (amountIn > stRaw) amountIn = stRaw;
    if (amountIn === 0n) return;
  } else {
    direction = 'sell_usdc';
    const gapUsd = (ratio - cfg.targetReserveRatio) * state.chainBalances.totalNotionalUsd;
    amountIn = clampUsdc(
      BigInt(Math.floor(gapUsd * 1_000_000)),
      cfg.minSwapUsdc,
      cfg.maxSwapUsdc,
    );
    tokenIn = usdcAddr;
    tokenOut = stAddr;
    if (amountIn > usdcRaw) amountIn = usdcRaw;
    if (amountIn === 0n) return;
  }

  console.log(
    `[${agentCfg.state.abbr}] auto-rebalance tick ${tickNo}: ratio=${(ratio * 100).toFixed(1)}% ` +
      `target=${(cfg.targetReserveRatio * 100).toFixed(1)}% → ${direction} amount=${amountIn}`,
  );

  try {
    const result = await swapExecutor.swap({ tokenIn, tokenOut, amount: amountIn });
    state.lastAutoSwapTick = tickNo;
    const explorerBase = (
      process.env.UNICHAIN_EXPLORER_BASE_URL ?? 'https://sepolia.uniscan.xyz'
    ).replace(/\/$/, '');
    const explorerUrl = `${explorerBase}/tx/${result.txHash}`;
    await memory.appendLog({
      kind: 'decision',
      at: new Date().toISOString(),
      summary: `auto-rebalance ${direction} → ${result.txHash.slice(0, 12)}…`,
      details: {
        tick: tickNo,
        direction,
        ratio,
        target: cfg.targetReserveRatio,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        expectedOut: result.expectedOut.toString(),
        txHash: result.txHash,
        explorerUrl,
        status: result.status,
      },
    });
    telemetry?.reportSwapExecuted({
      from_fips: agentCfg.state.fips,
      to_fips: agentCfg.state.fips, // self-trade
      give: { asset: tokenIn === usdcAddr ? 'USDC' : stateToken.symbol, amount: amountIn.toString() },
      receive: {
        asset: tokenOut === usdcAddr ? 'USDC' : stateToken.symbol,
        amount: result.expectedOut.toString(),
      },
      tx_hash: result.txHash,
      explorer_url: explorerUrl,
    });
    // Refresh balances right away so the next tick sees the new ratio and
    // doesn't re-trigger.
    if (deps.chainReader) {
      const next = await deps.chainReader.refresh();
      if (next) applyChainBalances(state, next);
    }
  } catch (err) {
    console.warn(
      `[${agentCfg.state.abbr}] auto-rebalance failed: ${(err as Error).message.slice(0, 240)}`,
    );
    await memory.appendLog({
      kind: 'decision',
      at: new Date().toISOString(),
      summary: `auto-rebalance failed: ${(err as Error).message.slice(0, 120)}`,
      details: { tick: tickNo, direction, ratio, target: cfg.targetReserveRatio, error: String(err) },
    });
  }
}

function clampUsdc(value: bigint, lo: bigint, hi: bigint): bigint {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function trim(decimal: string): string {
  // "1234.56789" → "1234.57"; cheap display compaction
  const dot = decimal.indexOf('.');
  if (dot === -1) return decimal;
  return decimal.slice(0, dot + 3);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
