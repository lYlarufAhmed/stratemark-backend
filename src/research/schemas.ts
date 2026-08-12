/**
 * Zod schemas for the model's structured outputs. Every structuring call is
 * validated against these before anything is assembled into a card — so a
 * malformed / hallucinated response is caught, not rendered. Defaults are
 * permissive (missing → Unknown/null) to honor the missing-data protocol.
 */
import { z } from 'zod';
import { cardTypeSchema, confidenceSchema } from '@mi/contracts';

export const metricOutSchema = z.object({
  value: z.number().nullable().default(null),
  confidence: confidenceSchema.default('unknown'),
  /** Index into the grounded citations array; null if not attributable. */
  sourceIndex: z.number().int().nullable().default(null),
  /** One-line "how we got this" note for estimated figures. */
  method: z.string().nullable().default(null),
});
export type MetricOut = z.infer<typeof metricOutSchema>;

export const marketPlanOutSchema = z.object({
  marketName: z.string().min(1),
  vertical: z.string().min(1),
  geography: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  searchThemes: z.array(z.string()).default([]),
});

// Tolerant of the model returning either { companies: [...] } or a bare [...].
const discoveryCompanySchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable().default(null),
  descriptor: z.string().default(''),
  primaryRole: z.enum(['company', 'infrastructure', 'distribution']).nullable().default(null),
  cardTypes: z.array(cardTypeSchema).default(['company']),
});

export const discoveryOutSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { companies: v } : v),
  z.object({
    companies: z.array(discoveryCompanySchema).max(40).default([]),
  }),
);

/** Strict schema for the primary discovery pass. Focused fallback passes remain
 * tolerant because a sparse niche is better represented honestly than padded. */
export const discoveryMinimumOutSchema = discoveryOutSchema.superRefine((value, ctx) => {
  const unique = new Set(value.companies.map((company) => company.name.trim().toLowerCase()));
  if (unique.size < 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['companies'],
      message: `Primary discovery must return at least 10 unique companies; received ${unique.size}.`,
    });
  }
});

export const enrichmentOutSchema = z.object({
  oneLiner: z.string().default(''),
  hqLocation: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  /** Brand colors scraped/inferred from the company's site, hex. */
  brand: z
    .object({
      primary: z.string().nullable().default(null),
      secondary: z.string().nullable().default(null),
      accent: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  // nullish (not just optional): the model often emits explicit null for
  // metrics it couldn't find — accept that and treat it as "absent".
  metrics: z
    .object({
      market_share: metricOutSchema.nullish(),
      valuation: metricOutSchema.nullish(),
      market_cap: metricOutSchema.nullish(),
      arr: metricOutSchema.nullish(),
      users: metricOutSchema.nullish(),
      employees: metricOutSchema.nullish(),
    })
    .default({}),
  viceClaims: z
    .array(z.object({ text: z.string(), sourceIndex: z.number().int().nullable().default(null) }))
    .default([]),
  cultureNote: z.string().nullable().default(null),
});
export type EnrichmentOut = z.infer<typeof enrichmentOutSchema>;

export const tierReviewOutSchema = z.object({
  nudge: z.union([z.literal(-1), z.literal(0), z.literal(1)]).default(0),
  reason: z.string().nullable().default(null),
});

/**
 * Batched tier review: ALL companies in one call.
 *
 * Two wins over reviewing each company separately. (1) Cost: a 10-company deck
 * drops 9 requests, which matters against a 15 RPM free-tier ceiling. (2) Quality:
 * the model sees the whole cohort at once, so "who deserves T8 vs T4" becomes a
 * relative judgement instead of ten independent guesses — which is what makes the
 * ranking defensible.
 */
export const tierReviewBatchOutSchema = z.object({
  reviews: z
    .array(
      z.object({
        name: z.string(),
        nudge: z.union([z.literal(-1), z.literal(0), z.literal(1)]).default(0),
        reason: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export const factCheckOutSchema = z.object({
  verdict: z.enum(['supported', 'contradicted', 'unverified']).default('unverified'),
  rationale: z.string().default(''),
});

/**
 * Market-level cards from ONE grounded pass: structural barriers to entry, plus
 * the non-obvious dynamics worth remembering (Insight cards). Both are claims
 * about the market rather than about a company, so they share a research call —
 * two card types for the price of one against a 15 RPM free-tier ceiling.
 *
 * `sourceIndex` points into the grounded citation list so each claim keeps its
 * evidence, the same discipline metrics and vice claims already follow.
 */
const marketClaimSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sourceIndex: z.number().int().nullable().default(null),
  /** The scannable substance behind the headline — 1-2 sentences each. */
  keyPoints: z.array(z.string()).default([]),
});

export const marketCardsOutSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { barriers: v } : v),
  z.object({
    barriers: z.array(marketClaimSchema).default([]),
    insights: z.array(marketClaimSchema).default([]),
  }),
);
