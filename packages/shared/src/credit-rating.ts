/**
 * Algorithmic credit rating — Phase 4.
 *
 * Pure function. Takes a state's reserve ratio + a few economic
 * indicators and produces a rating ('AAA'..'D') plus a yield floor
 * the issuer should expect to pay for new bond issuance. The bond
 * auction evaluator uses `yieldFloorBps` as the "minimum acceptable
 * yield I'd accept from a bidder" guardrail: any bid below floor is
 * rejected (issuer would rather not borrow than borrow at giveaway
 * yields).
 *
 * The model is intentionally simple — this is not a real CFA
 * methodology, just enough algorithm to make Phase 4's multi-bidder
 * auction visibly state-sensitive on the demo. Inputs we have access
 * to:
 *   - reserveRatio (treasury reserve / total value, normalized 0-1)
 *   - unemployment rate (FRED FRED:{ABBR}UR — higher = weaker)
 *   - per-capita personal income (FRED:{ABBR}PCPI — proxy for tax base)
 *   - persona coalitions (e.g. pension-stressed → ratings haircut)
 *
 * Output rating bands map roughly to long-run muni yields. We anchor
 * the AAA floor at 300bps (3.00%) and tier upward in 50-100bps steps.
 */

import { getPersona } from './personas.ts';

export type CreditRating =
  | 'AAA'
  | 'AA+'
  | 'AA'
  | 'AA-'
  | 'A+'
  | 'A'
  | 'A-'
  | 'BBB+'
  | 'BBB'
  | 'BBB-'
  | 'BB'
  | 'B'
  | 'C'
  | 'D';

export interface CreditInputs {
  /** Treasury reserve ratio (reserves / total_value_usd). */
  reserveRatio: number;
  /** Latest unemployment rate (percent). Optional — falls back to score 0. */
  unemploymentPct: number | null;
  /** Per-capita personal income in USD/year. Optional. */
  personalIncomeUsd: number | null;
  /** Region (e.g. 'northeast', 'south'). */
  region: string;
  /** Optional Phase 4+ extras — improve scoring fidelity when available. */
  /** YoY GDP growth from BEA SAGDP (%). Boosts score when positive. */
  gdpGrowthPct?: number | null;
  /** Census poverty rate (%). Penalizes score when high. */
  povertyRatePct?: number | null;
  /** Active shock pressure 0..10 (max severity of a NOAA event affecting this state). */
  shockPressure?: number | null;
}

export interface CreditAssessment {
  rating: CreditRating;
  /** Composite numeric score [0..100]; higher = stronger credit. */
  score: number;
  /** Minimum acceptable yield (bps) for new issuance. */
  yieldFloorBps: number;
  /** Yield ceiling — bids above this are rejected as too predatory. */
  yieldCeilingBps: number;
  /** Human-readable summary, used in award rationale strings. */
  summary: string;
}

const RATING_TABLE: ReadonlyArray<{
  minScore: number;
  rating: CreditRating;
  yieldFloorBps: number;
  yieldCeilingBps: number;
}> = [
  { minScore: 90, rating: 'AAA', yieldFloorBps: 300, yieldCeilingBps: 450 },
  { minScore: 85, rating: 'AA+', yieldFloorBps: 325, yieldCeilingBps: 475 },
  { minScore: 80, rating: 'AA', yieldFloorBps: 350, yieldCeilingBps: 500 },
  { minScore: 75, rating: 'AA-', yieldFloorBps: 375, yieldCeilingBps: 525 },
  { minScore: 70, rating: 'A+', yieldFloorBps: 400, yieldCeilingBps: 575 },
  { minScore: 65, rating: 'A', yieldFloorBps: 425, yieldCeilingBps: 625 },
  { minScore: 60, rating: 'A-', yieldFloorBps: 450, yieldCeilingBps: 675 },
  { minScore: 55, rating: 'BBB+', yieldFloorBps: 500, yieldCeilingBps: 750 },
  { minScore: 50, rating: 'BBB', yieldFloorBps: 550, yieldCeilingBps: 825 },
  { minScore: 45, rating: 'BBB-', yieldFloorBps: 600, yieldCeilingBps: 900 },
  { minScore: 35, rating: 'BB', yieldFloorBps: 700, yieldCeilingBps: 1100 },
  { minScore: 25, rating: 'B', yieldFloorBps: 850, yieldCeilingBps: 1400 },
  { minScore: 15, rating: 'C', yieldFloorBps: 1100, yieldCeilingBps: 2000 },
  { minScore: 0, rating: 'D', yieldFloorBps: 1500, yieldCeilingBps: 5000 },
];

function reserveScore(reserveRatio: number): number {
  // 0% reserves → 0 points; 20% → 50; 40%+ → 60 (cap).
  const r = Math.max(0, Math.min(reserveRatio, 0.5));
  return Math.min(60, r * 150); // 0.4 * 150 = 60
}

function unemploymentScore(pct: number | null): number {
  if (pct === null || !Number.isFinite(pct)) return 10; // neutral
  // 3% unemployment → 20; 6% → 10; 10%+ → 0
  if (pct <= 3) return 20;
  if (pct >= 10) return 0;
  return 20 - ((pct - 3) / 7) * 20;
}

function incomeScore(usd: number | null): number {
  if (usd === null || !Number.isFinite(usd)) return 10;
  // $40k → 0; $60k → 10; $80k → 20
  if (usd <= 40_000) return 0;
  if (usd >= 80_000) return 20;
  return ((usd - 40_000) / 40_000) * 20;
}

function personaPenalty(abbr: string): number {
  const persona = getPersona(abbr);
  if (persona.coalitions.includes('pension-stressed')) return 8;
  if (persona.coalitions.includes('hurricane-exposed')) return 4;
  return 0;
}

export function assessCredit(abbr: string, inputs: CreditInputs): CreditAssessment {
  const r = reserveScore(inputs.reserveRatio);
  const u = unemploymentScore(inputs.unemploymentPct);
  const i = incomeScore(inputs.personalIncomeUsd);
  const penalty = personaPenalty(abbr);

  // Phase 4+ refinements — small, additive, capped so the legacy path still passes.
  let bonus = 0;
  if (typeof inputs.gdpGrowthPct === 'number' && Number.isFinite(inputs.gdpGrowthPct)) {
    // -3% → -3, 0 → 0, +3% → +3, capped ±5
    bonus += Math.max(-5, Math.min(5, inputs.gdpGrowthPct));
  }
  let extraPenalty = 0;
  if (typeof inputs.povertyRatePct === 'number' && Number.isFinite(inputs.povertyRatePct)) {
    // 8% → 0, 12% → -2, 18%+ → -5
    if (inputs.povertyRatePct > 8) {
      extraPenalty += Math.min(5, (inputs.povertyRatePct - 8) / 2);
    }
  }
  if (typeof inputs.shockPressure === 'number' && Number.isFinite(inputs.shockPressure)) {
    // sev 0 → 0, sev 5 → -3, sev 10 → -6
    extraPenalty += Math.max(0, Math.min(6, inputs.shockPressure * 0.6));
  }

  const score = Math.max(0, Math.min(100, r + u + i + bonus - penalty - extraPenalty));

  const tier =
    RATING_TABLE.find((t) => score >= t.minScore) ?? RATING_TABLE[RATING_TABLE.length - 1];
  if (!tier) {
    // Defensive — RATING_TABLE always has entries.
    return {
      rating: 'D',
      score,
      yieldFloorBps: 1500,
      yieldCeilingBps: 5000,
      summary: `${abbr} credit: score=${score.toFixed(1)} (no rating tier matched)`,
    };
  }

  const summary = [
    `${abbr} credit: score=${score.toFixed(1)} → ${tier.rating}`,
    `(reserves=${(inputs.reserveRatio * 100).toFixed(1)}%`,
    inputs.unemploymentPct !== null ? `, unemp=${inputs.unemploymentPct.toFixed(1)}%` : '',
    inputs.personalIncomeUsd !== null
      ? `, income=$${(inputs.personalIncomeUsd / 1000).toFixed(0)}k`
      : '',
    penalty > 0 ? `, penalty=${penalty}` : '',
    ').',
    `Yield floor ${tier.yieldFloorBps}bps, ceiling ${tier.yieldCeilingBps}bps.`,
  ]
    .filter(Boolean)
    .join('');

  return {
    rating: tier.rating,
    score,
    yieldFloorBps: tier.yieldFloorBps,
    yieldCeilingBps: tier.yieldCeilingBps,
    summary,
  };
}
