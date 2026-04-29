/**
 * NOAA shock event ingestion.
 *
 * Two NOAA endpoints are useful for "is there a shock right now?":
 *
 *   1. NWS active alerts API — https://api.weather.gov/alerts/active
 *      No key required. Returns currently-active alerts (warnings, watches,
 *      advisories) with FIPS codes per affected geography. Best for
 *      real-time shock injection.
 *
 *   2. NCEI Storm Events CSV — https://www.ncei.noaa.gov/stormevents/...
 *      Historical (1+ month lag) but has property damage estimates.
 *      Used for backfill/replay scenarios; live demo uses NWS.
 *
 * This module wraps NWS active alerts (the live source). It groups
 * alerts by state FIPS, derives a `severity` 1-10 from event severity
 * + urgency + certainty, and exposes them as `ShockEvent` records the
 * data plane caches and serves at `GET /shocks`.
 *
 * No API key needed; NWS asks for a User-Agent identifying the client
 * (RFC 7231) — we send `federated-reserve/1.0`.
 */

import { type ShockEvent, lookupStateByFips } from '@federated-reserve/shared';
import { z } from 'zod';
import { TokenBucket } from '../rate-limit.ts';

const NOAA_RATE_LIMITER = new TokenBucket({ ratePerSec: 1 });
const NWS_BASE = 'https://api.weather.gov/alerts/active';
const USER_AGENT = 'federated-reserve/1.0 (https://federatedreserve.app)';

const RETRY_DELAYS_MS = [1500, 4000, 9000] as const;

const nwsParamSchema = z
  .object({
    SAME: z.array(z.string()).optional(),
  })
  .passthrough();

const nwsAlertSchema = z.object({
  id: z.string(),
  properties: z
    .object({
      id: z.string(),
      areaDesc: z.string().optional(),
      sent: z.string().optional(),
      effective: z.string().optional(),
      onset: z.string().optional(),
      expires: z.string().optional(),
      ends: z.string().nullable().optional(),
      status: z.string().optional(),
      messageType: z.string().optional(),
      category: z.string().optional(),
      severity: z.string().optional(),
      certainty: z.string().optional(),
      urgency: z.string().optional(),
      event: z.string().optional(),
      headline: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      response: z.string().optional(),
      parameters: nwsParamSchema.optional(),
      geocode: z
        .object({
          SAME: z.array(z.string()).optional(),
          UGC: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .passthrough(),
});

const nwsResponseSchema = z.object({
  features: z.array(nwsAlertSchema).default([]),
});

function severityToScore(sev?: string, urg?: string, cert?: string): number {
  // NWS severity: Extreme | Severe | Moderate | Minor | Unknown
  // urgency:     Immediate | Expected | Future | Past | Unknown
  // certainty:   Observed | Likely | Possible | Unlikely | Unknown
  let score = 1;
  switch ((sev ?? '').toLowerCase()) {
    case 'extreme':
      score += 6;
      break;
    case 'severe':
      score += 4;
      break;
    case 'moderate':
      score += 2;
      break;
    case 'minor':
      score += 1;
      break;
  }
  switch ((urg ?? '').toLowerCase()) {
    case 'immediate':
      score += 2;
      break;
    case 'expected':
      score += 1;
      break;
  }
  switch ((cert ?? '').toLowerCase()) {
    case 'observed':
      score += 1;
      break;
    case 'likely':
      score += 1;
      break;
  }
  return Math.max(1, Math.min(10, score));
}

function eventTypeToShockKind(event: string): ShockEvent['shock_kind'] {
  const e = event.toLowerCase();
  if (
    e.includes('hurricane') ||
    e.includes('tropical') ||
    e.includes('tornado') ||
    e.includes('flood') ||
    e.includes('storm') ||
    e.includes('snow') ||
    e.includes('blizzard') ||
    e.includes('heat') ||
    e.includes('fire') ||
    e.includes('quake') ||
    e.includes('tsunami') ||
    e.includes('wind') ||
    e.includes('ice')
  ) {
    return 'natural_disaster';
  }
  // NWS doesn't issue market or policy shocks; default to natural_disaster.
  return 'natural_disaster';
}

/**
 * SAME (Specific Area Message Encoding) codes are 6-digit county FIPS:
 *   PSSCCC — P=padding/zero, SS=state FIPS, CCC=county.
 * For our state-level rollup we just take SS.
 */
function sameToStateFips(same: string): number | null {
  if (!/^\d{6}$/.test(same)) return null;
  return Number(same.slice(1, 3));
}

interface NwsAlert {
  id: string;
  properties: {
    id: string;
    sent?: string;
    effective?: string;
    expires?: string;
    severity?: string;
    certainty?: string;
    urgency?: string;
    event?: string;
    headline?: string | null;
    description?: string | null;
    geocode?: { SAME?: string[]; UGC?: string[] };
  };
}

export interface NoaaFetchResult {
  events: ShockEvent[];
  errors: Array<{ source: string; error: string }>;
}

export async function fetchNoaaActiveShocks(opts?: {
  signal?: AbortSignal;
  /** Optional state FIPS allow-list (otherwise all states). */
  states?: readonly number[];
  /** Cap how many alerts to keep total (most-severe first). */
  cap?: number;
}): Promise<NoaaFetchResult> {
  const cap = opts?.cap ?? 100;
  const allow = opts?.states ? new Set(opts.states) : null;
  const errors: NoaaFetchResult['errors'] = [];

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await NOAA_RATE_LIMITER.acquire();
    try {
      const url = new URL(NWS_BASE);
      url.searchParams.set('status', 'actual');
      url.searchParams.set('message_type', 'alert,update');
      const res = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/geo+json',
        },
        signal: opts?.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`NWS ${res.status}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`NWS ${res.status}: ${body}`);
      }
      const json = await res.json();
      const parsed = nwsResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`NWS bad response: ${parsed.error.message}`);
      }

      const events: ShockEvent[] = [];
      const seenIdsByState = new Map<number, Set<string>>();

      for (const feature of parsed.data.features as NwsAlert[]) {
        const p = feature.properties;
        const same = p.geocode?.SAME ?? [];
        const stateFipsSet = new Set<number>();
        for (const code of same) {
          const fips = sameToStateFips(code);
          if (fips !== null) stateFipsSet.add(fips);
        }
        if (stateFipsSet.size === 0) continue;
        const event = p.event ?? 'Alert';
        const severity = severityToScore(p.severity, p.urgency, p.certainty);
        const begin = p.effective ?? p.sent ?? new Date().toISOString();
        const end = p.expires ?? begin;
        const narrative = (p.headline ?? p.description ?? event).slice(0, 800);

        for (const fips of stateFipsSet) {
          if (allow && !allow.has(fips)) continue;
          const state = lookupStateByFips(fips);
          if (!state) continue;
          let dedup = seenIdsByState.get(fips);
          if (!dedup) {
            dedup = new Set();
            seenIdsByState.set(fips, dedup);
          }
          // Dedup by event type per state — multiple counties under one
          // hurricane shouldn't generate 80 events for the demo.
          const dedupKey = `${event}|${begin.slice(0, 10)}`;
          if (dedup.has(dedupKey)) continue;
          dedup.add(dedupKey);
          events.push({
            event_id: `${p.id}|${fips}`,
            state_fips: fips,
            state_abbr: state.abbr,
            event_type: event,
            shock_kind: eventTypeToShockKind(event),
            severity,
            begin_date: begin,
            end_date: end,
            property_damage_usd: null,
            deaths: null,
            narrative,
          });
        }
      }

      events.sort((a, b) => b.severity - a.severity || b.begin_date.localeCompare(a.begin_date));
      return { events: events.slice(0, cap), errors };
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        errors.push({ source: 'NWS', error: String(err) });
        return { events: [], errors };
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  return { events: [], errors };
}
