/**
 * CMS signal weights and tier band tables (spec §6.1, §6.2).
 *
 * Bands are encoded as monotonic, non-overlapping numeric ranges [min, max).
 * The spec's qualitative overlaps (e.g. Legacy vs Scale on valuation) are
 * intentionally resolved into monotonic numeric bands here; the qualitative
 * distinction (e.g. "high but flat/declining" market share) is captured by the
 * market-share signal plus the LLM ±1 review nudge, not by overlapping bands.
 */
import type { MaturityTier } from './enums';

/** The five weighted CMS signals. `value` = valuation OR market cap (mutually exclusive). */
export type CmsSignalKey = 'marketShare' | 'value' | 'arr' | 'users' | 'employees';

export const CMS_SIGNAL_KEYS: readonly CmsSignalKey[] = [
  'marketShare',
  'value',
  'arr',
  'users',
  'employees',
];

/** Nominal weights (spec §6.1). Sum = 1.0. Renormalized per-company across available signals. */
export const CMS_WEIGHTS: Record<CmsSignalKey, number> = {
  marketShare: 0.3,
  value: 0.2,
  arr: 0.2,
  users: 0.15,
  employees: 0.15,
};

export const CMS_SIGNAL_LABELS: Record<CmsSignalKey, string> = {
  marketShare: 'Market Share',
  value: 'Valuation / Market Cap',
  arr: 'ARR',
  users: 'Users',
  employees: 'Employees',
};

interface Band {
  tier: MaturityTier;
  /** inclusive lower bound */
  min: number;
  /** exclusive upper bound */
  max: number;
}

/** ARR in USD (spec §6.2). Tier 1 = pre-revenue (~$0). */
export const ARR_BANDS: readonly Band[] = [
  { tier: 1, min: 0, max: 1 },
  { tier: 2, min: 1, max: 1_000_000 },
  { tier: 3, min: 1_000_000, max: 5_000_000 },
  { tier: 4, min: 5_000_000, max: 20_000_000 },
  { tier: 5, min: 20_000_000, max: 75_000_000 },
  { tier: 6, min: 75_000_000, max: 250_000_000 },
  { tier: 7, min: 250_000_000, max: 1_000_000_000 },
  { tier: 8, min: 1_000_000_000, max: Number.POSITIVE_INFINITY },
];

/** Employee headcount (spec §6.2). */
export const EMPLOYEE_BANDS: readonly Band[] = [
  { tier: 1, min: 0, max: 5 },
  { tier: 2, min: 5, max: 20 },
  { tier: 3, min: 20, max: 75 },
  { tier: 4, min: 75, max: 300 },
  { tier: 5, min: 300, max: 1_000 },
  { tier: 6, min: 1_000, max: 5_000 },
  { tier: 7, min: 5_000, max: 10_000 },
  { tier: 8, min: 10_000, max: Number.POSITIVE_INFINITY },
];

/** Valuation (private) or market cap (public), USD (spec §6.2, monotonic). */
export const VALUE_BANDS: readonly Band[] = [
  { tier: 1, min: 0, max: 5_000_000 },
  { tier: 2, min: 5_000_000, max: 20_000_000 },
  { tier: 3, min: 20_000_000, max: 60_000_000 },
  { tier: 4, min: 60_000_000, max: 200_000_000 },
  { tier: 5, min: 200_000_000, max: 1_000_000_000 },
  { tier: 6, min: 1_000_000_000, max: 10_000_000_000 },
  { tier: 7, min: 10_000_000_000, max: 50_000_000_000 },
  { tier: 8, min: 50_000_000_000, max: Number.POSITIVE_INFINITY },
];

/**
 * Market share as a percentage 0–100 (spec §6.2).
 * Trajectory nuance (fast-growing at T5, flat/declining at T7) is not encodable
 * as a level band — it is left to the LLM review nudge, which logs a reason.
 */
export const MARKET_SHARE_BANDS: readonly Band[] = [
  { tier: 1, min: 0, max: 0.1 },
  { tier: 2, min: 0.1, max: 0.5 },
  { tier: 3, min: 0.5, max: 2 },
  { tier: 4, min: 2, max: 5 },
  { tier: 5, min: 5, max: 10 },
  { tier: 6, min: 10, max: 20 },
  { tier: 7, min: 20, max: 40 },
  { tier: 8, min: 40, max: Number.POSITIVE_INFINITY },
];

export const SIGNAL_BANDS: Record<Exclude<CmsSignalKey, 'users'>, readonly Band[]> = {
  marketShare: MARKET_SHARE_BANDS,
  value: VALUE_BANDS,
  arr: ARR_BANDS,
  employees: EMPLOYEE_BANDS,
};

/** Map a numeric value to a tier using a band table. Returns null for negative/NaN input. */
export function mapValueToTier(bands: readonly Band[], value: number): MaturityTier | null {
  if (!Number.isFinite(value) || value < 0) return null;
  for (const band of bands) {
    if (value >= band.min && value < band.max) return band.tier;
  }
  // Above the top band's min (open-ended) → highest tier.
  const top = bands[bands.length - 1];
  if (top && value >= top.min) return top.tier;
  return null;
}

/**
 * Score the "users" signal RELATIVELY within a deck (spec §6.2 note + confirmed
 * assumption): rank this company's user count against all companies in the same
 * deck and map its percentile onto tiers 1–8. Requires at least two distinct
 * values for a meaningful ranking; otherwise returns null (signal excluded).
 */
export function mapUsersRelative(value: number, deckUserValues: number[]): MaturityTier | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const distinct = Array.from(new Set(deckUserValues.filter((v) => Number.isFinite(v) && v >= 0)));
  if (distinct.length < 2) return null;
  distinct.sort((a, b) => a - b);
  // Position of the largest entry <= value (dense rank against distinct values).
  let index = 0;
  for (let i = 0; i < distinct.length; i += 1) {
    const entry = distinct[i];
    if (entry !== undefined && value >= entry) index = i;
  }
  const percentile = index / (distinct.length - 1); // 0..1
  const tier = Math.round(percentile * 7) + 1;
  return Math.min(8, Math.max(1, tier)) as MaturityTier;
}
