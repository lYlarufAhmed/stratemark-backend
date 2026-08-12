/**
 * Company Maturity Score (CMS) — tier assignment engine (spec §6.3, §6.4).
 *
 * PURE + DETERMINISTIC. This is the auditable core of the product and lives in
 * shared code so it runs identically in the renderer (display/tests today) and
 * in the back end (real scoring tomorrow).
 *
 * Pipeline (spec §6.3, "hybrid"):
 *   1. Map each AVAILABLE signal to its band tier.
 *   2. Weighted-average the tiers, renormalizing weights across available
 *      signals only (spec §6.4 — an Unknown signal is NEVER scored as 0).
 *   3. Round to the nearest whole tier → base tier.
 *   4. The LLM may nudge ±1 with a logged reason (applied here as data, never
 *      assigned from scratch — see `applyNudge`, which throws on |nudge| > 1).
 */
import type { Confidence, MaturityTier } from './enums';
import {
  CMS_SIGNAL_KEYS,
  CMS_WEIGHTS,
  SIGNAL_BANDS,
  type CmsSignalKey,
  mapUsersRelative,
  mapValueToTier,
} from './tiers';

export interface CmsSignalInput {
  /** Numeric value, or null when there is no usable figure. */
  value: number | null;
  confidence: Confidence;
}

export interface CmsValueSignalInput extends CmsSignalInput {
  /** Which figure this is — for display/audit. Null when unknown. */
  kind: 'valuation' | 'market_cap' | null;
}

export interface CmsInput {
  /** Market share as a percentage (0–100). */
  marketShare: CmsSignalInput;
  /** Valuation OR market cap (mutually exclusive per company), USD. */
  value: CmsValueSignalInput;
  /** Annual recurring revenue, USD. */
  arr: CmsSignalInput;
  /** Number of users (scored relative to the deck). */
  users: CmsSignalInput;
  /** Headcount. */
  employees: CmsSignalInput;
}

export interface CmsContext {
  /** All usable user values across companies in the same deck, for relative users scoring. */
  deckUserValues: number[];
}

export interface CmsPerSignal {
  key: CmsSignalKey;
  available: boolean;
  rawValue: number | null;
  confidence: Confidence;
  signalTier: MaturityTier | null;
  baseWeight: number;
  /** Weight after renormalizing across available signals (0 when unavailable). */
  effectiveWeight: number;
}

export type Nudge = -1 | 0 | 1;

export interface CmsResult {
  /** Rules-based tier before the LLM review nudge. Null when no signal is available. */
  baseTier: MaturityTier | null;
  /** Tier after applying the (validated) LLM nudge. */
  finalTier: MaturityTier | null;
  /** Pre-rounding weighted tier average (for transparency). */
  weightedTierRaw: number | null;
  perSignal: CmsPerSignal[];
  appliedNudge: Nudge;
  nudgeReason: string | null;
  availableSignalCount: number;
}

export interface ComputeCmsOptions {
  /** LLM review nudge. Must be within ±1 (spec §6.3). */
  nudge?: Nudge;
  nudgeReason?: string | null;
}

function clampTier(n: number): MaturityTier {
  return Math.min(8, Math.max(1, n)) as MaturityTier;
}

function signalTierFor(
  key: CmsSignalKey,
  value: number,
  context: CmsContext,
): MaturityTier | null {
  if (key === 'users') return mapUsersRelative(value, context.deckUserValues);
  return mapValueToTier(SIGNAL_BANDS[key], value);
}

/**
 * Validate and apply the LLM review nudge. The LLM may only REVIEW the
 * rules-based result — it can never assign a tier from scratch (spec §6.3),
 * so a magnitude greater than 1 is a programming error and throws.
 */
export function applyNudge(baseTier: MaturityTier | null, nudge: Nudge): MaturityTier | null {
  if (nudge !== -1 && nudge !== 0 && nudge !== 1) {
    throw new RangeError(`CMS nudge must be within ±1, received ${String(nudge)}`);
  }
  if (baseTier === null) return null;
  return clampTier(baseTier + nudge);
}

export function computeCms(
  input: CmsInput,
  context: CmsContext,
  options: ComputeCmsOptions = {},
): CmsResult {
  const nudge: Nudge = options.nudge ?? 0;

  const perSignal: CmsPerSignal[] = CMS_SIGNAL_KEYS.map((key) => {
    const signal = input[key];
    const usable = signal.confidence !== 'unknown' && signal.value !== null;
    const signalTier = usable ? signalTierFor(key, signal.value as number, context) : null;
    return {
      key,
      available: signalTier !== null,
      rawValue: signal.value,
      confidence: signal.confidence,
      signalTier,
      baseWeight: CMS_WEIGHTS[key],
      effectiveWeight: 0,
    };
  });

  const available = perSignal.filter((s) => s.available);
  const totalAvailableWeight = available.reduce((sum, s) => sum + s.baseWeight, 0);

  if (available.length === 0 || totalAvailableWeight === 0) {
    return {
      baseTier: null,
      finalTier: null,
      weightedTierRaw: null,
      perSignal,
      appliedNudge: nudge,
      nudgeReason: options.nudgeReason ?? null,
      availableSignalCount: 0,
    };
  }

  let weightedTierRaw = 0;
  for (const s of available) {
    s.effectiveWeight = s.baseWeight / totalAvailableWeight;
    weightedTierRaw += s.effectiveWeight * (s.signalTier as MaturityTier);
  }

  const baseTier = clampTier(Math.round(weightedTierRaw));
  const finalTier = applyNudge(baseTier, nudge);

  return {
    baseTier,
    finalTier,
    weightedTierRaw,
    perSignal,
    appliedNudge: nudge,
    nudgeReason: options.nudgeReason ?? null,
    availableSignalCount: available.length,
  };
}

/**
 * Build a CmsInput from a company's raw metric rows. Convenience for the mock
 * repository and (later) the back end — keeps the mapping from the flat
 * metric table to the five weighted signals in one audited place.
 */
export interface MetricLike {
  metricType: 'market_cap' | 'valuation' | 'market_share' | 'arr' | 'users' | 'employees';
  value: number | null;
  confidence: Confidence;
}

export function buildCmsInput(metrics: MetricLike[]): CmsInput {
  const find = (type: MetricLike['metricType']) => metrics.find((m) => m.metricType === type);

  const valuation = find('valuation');
  const marketCap = find('market_cap');
  // Mutually exclusive: prefer whichever is present (valuation for private, cap for public).
  const valueMetric = valuation ?? marketCap ?? null;

  const asSignal = (m: MetricLike | undefined | null): CmsSignalInput => ({
    value: m?.value ?? null,
    confidence: m?.confidence ?? 'unknown',
  });

  return {
    marketShare: asSignal(find('market_share')),
    value: {
      ...asSignal(valueMetric),
      kind: valuation ? 'valuation' : marketCap ? 'market_cap' : null,
    },
    arr: asSignal(find('arr')),
    users: asSignal(find('users')),
    employees: asSignal(find('employees')),
  };
}
