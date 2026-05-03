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
import {
  COALITION_TAGS,
  getPersona,
  loadDeployments,
  lookupStateByAbbr,
  lookupStateByFips,
} from '@federated-reserve/shared';
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

/**
 * Send a bond-auction bid to a deployed bond's issuer. Picks a random
 * bond from contracts/deployments/<chain>.json, skips bonds we issued
 * ourselves, and bids a small principal at a yield jittered around the
 * coupon rate so the issuer's credit floor/ceiling check has work to do.
 *
 * The issuer's BondAuctionRegistry batches incoming bids over a window
 * and awards the lowest-yield eligible bid; if our bid wins, the issuer
 * fires BondToken.mint on Unichain Sepolia, surfacing the tx_hash on
 * the Negotiations tab.
 */
export async function maybeInitiateBondBid(deps: TickDeps, _tickNo: number): Promise<void> {
  let bonds: ReturnType<typeof loadDeployments>['bonds'];
  try {
    const deployments = loadDeployments('unichain-sepolia');
    bonds = deployments.bonds;
  } catch {
    return; // deployments missing — silent
  }
  if (!bonds) return;
  const candidateIds = Object.keys(bonds).filter((id) => {
    const b = bonds?.[id];
    return b && b.issuerFips !== deps.cfg.state.fips;
  });
  if (candidateIds.length === 0) return;

  const bondId = pickRandomChoice(candidateIds);
  if (!bondId) return;
  const bond = bonds[bondId];
  if (!bond) return;

  const issuerState = lookupStateByFips(bond.issuerFips);
  if (!issuerState) return;

  const issuerPub = await resolvePeerByAbbr(deps, issuerState.abbr);
  if (!issuerPub) return;

  // Bid a small principal (5–25% of the offered total) at a yield
  // jittered ±50bps off the coupon. The issuer's credit reasoner will
  // reject anything below floor or above ceiling — that's the point.
  const fullPrincipalUsd = Number(BigInt(bond.principalUsdcBase) / 1_000_000n);
  const principalUsd = Math.max(
    100,
    Math.floor(fullPrincipalUsd * (0.05 + Math.random() * 0.2)),
  );
  const jitterBps = Math.floor((Math.random() - 0.5) * 100); // ±50bps
  const bidYieldBps = Math.max(50, bond.couponBps + jitterBps);

  const rationale = pickRandomChoice([
    `${deps.cfg.state.abbr} bidding for ${issuerState.abbr} treasury exposure at competitive yield.`,
    `${deps.cfg.state.abbr} hedging interest-rate exposure with high-grade ${issuerState.abbr} paper.`,
    `${deps.cfg.state.abbr} adding duration to the reserve via ${bond.symbol}.`,
    `${deps.cfg.state.abbr} taking the offered ${bond.couponBps}bps coupon as a baseline; bidding ${bidYieldBps}bps to win.`,
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
              skill: 'bond-auction',
              issuer_fips: bond.issuerFips,
              bidder_fips: deps.cfg.state.fips,
              bond_id: bondId,
              principal_usd: principalUsd,
              bid_yield_bps: bidYieldBps,
              rationale,
            },
          },
        ],
      },
    },
  };

  try {
    await deps.axl.callRemoteA2a(issuerPub, body);
    console.log(
      `[${deps.cfg.state.abbr}] initiated bond bid → ${issuerState.abbr} (${bondId}): principal=$${principalUsd} yield=${bidYieldBps}bps`,
    );
  } catch (err) {
    console.warn(
      `[${deps.cfg.state.abbr}] initiate-bond-bid to ${issuerState.abbr} failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

async function resolvePeerByAbbr(deps: TickDeps, abbr: string): Promise<string | null> {
  const peers = deps.discovery.knownPeers();
  for (const pubkey of peers) {
    const info = await resolvePeer(deps, pubkey);
    if (info?.abbr === abbr) return pubkey;
  }
  return null;
}
