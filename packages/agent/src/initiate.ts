/**
 * Proactive A2A negotiation initiator.
 *
 * Phase 5+ — without an initiator the Agent Negotiations tab stays empty,
 * because the executor only handles inbound A2A messages. This module
 * fires periodic outbound proposals on non-federal agents so the dashboard
 * has visible multi-turn threads even when no NOAA shocks are active.
 *
 *   maybeInitiateSwap      — bilateral swap proposal to a random peer
 *   maybeInitiateCoalition — coalition invite based on persona affinities
 *
 * Both are best-effort: each runs on a per-agent cooldown, fails quietly,
 * and never blocks the tick loop. The responder's `handleNegotiateSwap` /
 * `handleCoalitionInvite` already push every round to the observer, so
 * this module only has to fire the first message.
 */

import { randomUUID } from 'node:crypto';
import { COALITION_TAGS, getPersona, lookupStateByAbbr } from '@federated-reserve/shared';
import type { TickDeps } from './tick.ts';

interface PeerInfo {
  pubkey: string;
  abbr: string;
  fips: number;
}

const peerCardCache = new Map<string, { abbr: string | null; fips: number | null; ts: number }>();
const CARD_TTL_MS = 5 * 60 * 1000;

async function resolvePeer(deps: TickDeps, pubkey: string): Promise<PeerInfo | null> {
  const cached = peerCardCache.get(pubkey);
  if (cached && Date.now() - cached.ts < CARD_TTL_MS) {
    if (cached.abbr && cached.fips != null) {
      return { pubkey, abbr: cached.abbr, fips: cached.fips };
    }
    return null;
  }
  try {
    const card = (await deps.axl.getRemoteAgentCard(pubkey)) as { name?: string };
    const name = (card?.name ?? '').toLowerCase();
    const match = NAME_TO_ABBR.find((entry) => name.includes(entry.needle));
    if (!match) {
      peerCardCache.set(pubkey, { abbr: null, fips: null, ts: Date.now() });
      return null;
    }
    const info = lookupStateByAbbr(match.abbr);
    if (!info) {
      peerCardCache.set(pubkey, { abbr: null, fips: null, ts: Date.now() });
      return null;
    }
    peerCardCache.set(pubkey, { abbr: info.abbr, fips: info.fips, ts: Date.now() });
    return { pubkey, abbr: info.abbr, fips: info.fips };
  } catch {
    peerCardCache.set(pubkey, { abbr: null, fips: null, ts: Date.now() });
    return null;
  }
}

const NAME_TO_ABBR: Array<{ needle: string; abbr: string }> = [
  { needle: 'massachusetts', abbr: 'MA' },
  { needle: 'california', abbr: 'CA' },
  { needle: 'texas', abbr: 'TX' },
  { needle: 'new york', abbr: 'NY' },
  { needle: 'florida', abbr: 'FL' },
  { needle: 'illinois', abbr: 'IL' },
  { needle: 'washington', abbr: 'WA' },
  { needle: 'alaska', abbr: 'AK' },
  { needle: 'federal reserve', abbr: 'FED' },
  { needle: 'treasury', abbr: 'TRS' },
];

async function pickRandomNonFederalPeer(deps: TickDeps): Promise<PeerInfo | null> {
  const peers = deps.discovery.knownPeers();
  if (peers.length === 0) return null;
  const shuffled = [...peers].sort(() => Math.random() - 0.5);
  for (const pubkey of shuffled) {
    const info = await resolvePeer(deps, pubkey);
    if (!info) continue;
    if (info.abbr === 'FED' || info.abbr === 'TRS') continue;
    if (info.fips === deps.cfg.state.fips) continue;
    return info;
  }
  return null;
}

/**
 * Send a small bilateral swap proposal to a random known peer.
 * The peer's executor handles negotiation rounds and pushes them to the
 * observer; we don't need to follow up unless we want to drive accept/reject
 * dynamics on the initiator side.
 */
export async function maybeInitiateSwap(deps: TickDeps, tickNo: number): Promise<void> {
  const peer = await pickRandomNonFederalPeer(deps);
  if (!peer) {
    if (tickNo % 12 === 0) {
      console.log(`[${deps.cfg.state.abbr}] initiate-swap skip: no eligible peers resolved yet`);
    }
    return;
  }

  // Small-amount swap so any settlement attempt downstream stays bounded.
  // Asset symbols use the responder's state token (e.g. MA-TOKEN) so the
  // settlement leg can resolve when both sides have the right wallets.
  const giveAmountUsdcBase = pickRandomChoice([
    '50000000', // 50 USDC
    '100000000', // 100 USDC
    '250000000', // 250 USDC
  ]);
  const receiveAmount18 = pickRandomChoice([
    '25000000000000000000', // 25 tokens
    '50000000000000000000', // 50 tokens
    '100000000000000000000', // 100 tokens
  ]);

  const rationale = pickRandomChoice([
    `${deps.cfg.state.abbr} rebalancing toward ${peer.abbr} regional exposure.`,
    `${deps.cfg.state.abbr} diversifying reserve composition with ${peer.abbr} state token.`,
    `${deps.cfg.state.abbr} closing a small overweight in USDC; bidding ${peer.abbr} for treasury balance.`,
    `${deps.cfg.state.abbr} executing a tactical exposure rotation into ${peer.abbr}.`,
  ]);

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
              kind: 'proposal',
              initiator_fips: deps.cfg.state.fips,
              give: { asset: 'USDC', amount: giveAmountUsdcBase },
              receive: { asset: `${peer.abbr}-TOKEN`, amount: receiveAmount18 },
              rationale,
            },
          },
        ],
      },
    },
  };

  try {
    await deps.axl.callRemoteA2a(peer.pubkey, body);
    console.log(
      `[${deps.cfg.state.abbr}] initiated swap → ${peer.abbr}: give=${giveAmountUsdcBase} USDC receive=${receiveAmount18} ${peer.abbr}-TOKEN`,
    );
  } catch (err) {
    console.warn(
      `[${deps.cfg.state.abbr}] initiate-swap to ${peer.abbr} failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

/**
 * Send a coalition invite to a random peer that shares (or could share)
 * coalition affinity with us. Pulls coalition tags from the persona; falls
 * back to a generic regional tag otherwise.
 */
export async function maybeInitiateCoalition(deps: TickDeps, _tickNo: number): Promise<void> {
  const peer = await pickRandomNonFederalPeer(deps);
  if (!peer) return;

  const persona = getPersona(deps.cfg.state.abbr);
  const tag =
    pickRandomChoice(persona.coalitions) ?? pickRandomChoice(COALITION_TAGS as readonly string[]);
  if (!tag) return;

  const contributionUsd = pickRandomChoice([100_000, 250_000, 500_000, 1_000_000]);
  const durationDays = pickRandomChoice([30, 60, 90]);

  const topic = pickRandomChoice([
    `${tag} liquidity backstop pool`,
    `${tag} regional disaster reserve`,
    `${tag} short-term funding facility`,
    `${tag} cross-state hedging coalition`,
  ]);

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
              skill: 'participate-in-coalition',
              initiator_fips: deps.cfg.state.fips,
              coalition_tag: tag,
              topic,
              proposed_contribution_usd: contributionUsd,
              duration_days: durationDays,
            },
          },
        ],
      },
    },
  };

  try {
    await deps.axl.callRemoteA2a(peer.pubkey, body);
    console.log(
      `[${deps.cfg.state.abbr}] initiated coalition invite → ${peer.abbr}: tag=${tag} ask=$${contributionUsd}`,
    );
  } catch (err) {
    console.warn(
      `[${deps.cfg.state.abbr}] initiate-coalition to ${peer.abbr} failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

function pickRandomChoice<T>(choices: readonly T[]): T | undefined {
  if (choices.length === 0) return undefined;
  return choices[Math.floor(Math.random() * choices.length)];
}
