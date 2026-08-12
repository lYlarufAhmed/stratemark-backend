/**
 * Zod schemas — the runtime contract that mirrors the SQLite/Drizzle data model
 * (spec §10) and every per-tab dashboard payload. Every value crossing the
 * repository boundary is validated against these, so malformed back-end data is
 * caught, never silently rendered (see Constraints).
 */
import { z } from 'zod';
import {
  CARD_TYPES,
  CONFIDENCE_LEVELS,
  DASHBOARD_TABS,
  METRIC_TYPES,
  REFRESH_CADENCES,
} from './enums';

// Enum schemas -------------------------------------------------------------
export const cardTypeSchema = z.enum(CARD_TYPES);
export const metricTypeSchema = z.enum(METRIC_TYPES);
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export const refreshCadenceSchema = z.enum(REFRESH_CADENCES);
export const dashboardTabSchema = z.enum(DASHBOARD_TABS);
export const maturityTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
]);

// ISO-8601 timestamps travel as strings across the boundary (SQLite text / JSON).
const isoTimestamp = z.string().min(1);

// Core tables (spec §10) ---------------------------------------------------
export const scopeDefinitionSchema = z.object({
  vertical: z.string().min(1),
  geography: z.string().nullable(),
  notes: z.string().nullable(),
});

export const marketSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  scopeDefinition: scopeDefinitionSchema,
  refreshCadence: refreshCadenceSchema,
  createdAt: isoTimestamp,
});

export const deckSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  createdAt: isoTimestamp,
  lastRefreshedAt: isoTimestamp.nullable(),
});

export const brandThemeSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  accent: z.string(),
  text: z.string(),
  background: z.string(),
  fontFamily: z.string().nullable(),
  source: z.enum(['scraped', 'llm', 'manual', 'default']),
});

export const companySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  oneLiner: z.string(),
  logoUrl: z.string().nullable(),
  hqLocation: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  brandTheme: brandThemeSchema.nullable(),
});

export const companyMetricSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  metricType: metricTypeSchema,
  value: z.number().nullable(), // null iff confidence === 'unknown'
  confidence: confidenceSchema,
  source: z.string().nullable(), // primary citation URL (back-compat; mirrors citations[0])
  /**
   * Every source behind THIS figure.
   *
   * `title` holds the publisher (e.g. "carnegieendowment.org") and is what the
   * UI shows: grounding URLs are opaque `vertexaisearch...` redirects that also
   * expire, so the publisher name is the durable half of the provenance.
   * Defaulted to [] so snapshots written before this field still parse.
   */
  citations: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        credibility: z
          .enum(['primary', 'reputable_secondary', 'industry', 'user_generated', 'unknown'])
          .optional(),
      }),
    )
    .default([]),
  methodNote: z.string().nullable(), // "how we got this number" for estimated figures
  capturedAt: isoTimestamp,
  conflicts: z
    .array(
      z.object({
        metricType: metricTypeSchema,
        observations: z.array(
          z.object({
            value: z.number().nullable(),
            confidence: confidenceSchema,
            source: z.string().nullable(),
            capturedAt: isoTimestamp,
          }),
        ),
        detectedAt: isoTimestamp,
        preferredObservation: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  revision: z.number().int().nonnegative().optional(),
});

export const cardSchema = z.object({
  id: z.string(),
  deckId: z.string(),
  // Nullable: Barrier-to-Entry cards are not company-specific (spec §4).
  companyId: z.string().nullable(),
  cardType: cardTypeSchema,
  // Used for non-company cards (Barrier); company cards derive these from the company.
  title: z.string().nullable(),
  summary: z.string().nullable(),
  tier: maturityTierSchema.nullable(), // only Company cards carry a tier
  tierReason: z.string().nullable(), // LLM ±1 review reasoning (spec §6.3)
  // Market-level cards (Barrier, Insight) state a claim rather than a figure, so
  // they carry their own evidence. Defaulted, so company cards and older stored
  // decks parse unchanged.
  citations: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        credibility: z
          .enum(['primary', 'reputable_secondary', 'industry', 'user_generated', 'unknown'])
          .optional(),
      }),
    )
    .default([]),
  /**
   * For market-level cards (Insight, Barrier): the researched key points behind
   * the headline — each one or two sentences, scannable. Empty for company
   * cards and for decks baked before this field existed.
   */
  keyPoints: z.array(z.string()).default([]),
  createdAt: isoTimestamp,
});

export const viceClaimSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  claimText: z.string().min(1),
  sourceUrl: z.string().min(1), // REQUIRED — every Vice claim must be sourced (spec §4, §6.4)
  /**
   * The publisher behind the source (grounding supplies a title with every
   * URL). The URL alone is an opaque, expiring Google redirect — the publisher
   * name is the durable half of the provenance, same rule as metric citations.
   */
  sourceTitle: z.string().nullable().default(null),
  capturedAt: isoTimestamp,
});

// Dashboard per-tab content contracts (spec §8) ----------------------------
//
// These are TOLERANT by design. A research pass returns what the sources
// actually support, and an all-or-nothing schema turns one missing sub-field
// into a completely blank tab: measured on a live bake, 21% of tabs were lost
// because a single string (an `ethos`, a timeline `detail`) wasn't there.
//
// The product already treats "unknown" as a first-class state for figures. The
// same rule belongs here: render what was found, leave the rest visibly empty.
// Tolerance never invents anything — a dropped row is a gap, not a guess.

/** Prose that may simply not exist in the sources. */
const prose = () => z.string().catch('');

/**
 * An array that keeps the rows that parsed. A malformed row is discarded rather
 * than taking its siblings down with it, and a non-array becomes empty.
 */
const rows = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item.nullable().catch(null))
    .catch([])
    .transform((list) => list.filter((r): r is z.output<T> => r !== null));

export const overviewContentSchema = z.object({
  markdown: prose(),
});

export const liveIntelItemSchema = z.object({
  id: z.string(),
  source: z.enum(['news', 'x', 'reddit']),
  title: z.string(),
  url: z.string(),
  summary: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  publishedAt: isoTimestamp,
  stale: z.boolean(),
});
export const liveIntelContentSchema = z.object({
  items: rows(liveIntelItemSchema),
  lastRefreshedAt: isoTimestamp.nullable().catch(null),
  cadence: refreshCadenceSchema.catch('weekly'),
});

export const orgNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: prose(),
  // An unrecognised grouping is "other" — a real person in the wrong swimlane
  // beats losing the whole org chart.
  group: z.enum(['exec', 'ai', 'product', 'design', 'other']).catch('other'),
  parentId: z.string().nullable().catch(null),
  /** One-two sourced sentences about the person, when reporting exists. */
  bio: prose(),
});
export const teamOrgContentSchema = z.object({
  nodes: rows(orgNodeSchema),
});

export const liveLandingContentSchema = z.object({
  url: z.string(),
  embeddable: z.boolean().catch(false),
  screenshotUrl: z.string().nullable().catch(null),
});

export const timePointSchema = z.object({ period: z.string(), value: z.number() });
export const capTableSliceSchema = z.object({ holder: z.string(), pct: z.number() });
export const metricsContentSchema = z.object({
  revenue: rows(timePointSchema),
  users: rows(timePointSchema),
  churn: rows(timePointSchema),
  nps: rows(timePointSchema),
  capTable: rows(capTableSliceSchema),
});

export const boardMemberSchema = z.object({ name: z.string(), affiliation: prose() });
export const missionGovernanceContentSchema = z.object({
  mission: prose(),
  ethos: prose(),
  governanceStructure: prose(),
  board: rows(boardMemberSchema),
  positives: rows(z.string()),
  negatives: rows(z.string()),
});

export const timelineEventSchema = z.object({
  date: prose(),
  title: z.string(),
  detail: prose(),
});
export const quoteSchema = z.object({ text: z.string(), attribution: prose() });
export const historyContentSchema = z.object({
  founderStory: prose(),
  timeline: rows(timelineEventSchema),
  quotes: rows(quoteSchema),
});

export const productSchema = z.object({
  name: z.string(),
  description: prose(),
  /**
   * What is publicly reported about this product's revenue contribution —
   * honest prose ("~70% of revenue per 2025 10-K", "not disclosed"), never an
   * invented figure. Ranking in the UI follows the researched order.
   */
  revenueNote: prose(),
  // No neutral value exists here, so an unreadable status drops the row rather
  // than asserting a lifecycle stage we did not find.
  status: z.enum(['live', 'beta', 'sunset']),
});
export const roadmapItemSchema = z.object({
  title: z.string(),
  horizon: z.enum(['now', 'next', 'later']),
  detail: prose(),
});
export const productsRoadmapContentSchema = z.object({
  products: rows(productSchema),
  roadmap: rows(roadmapItemSchema),
});

/** Tab → content schema. Used to validate `dashboard_data.content_json` per tab. */
export const DASHBOARD_CONTENT_SCHEMAS = {
  overview: overviewContentSchema,
  live_intel: liveIntelContentSchema,
  team_org: teamOrgContentSchema,
  live_landing: liveLandingContentSchema,
  metrics: metricsContentSchema,
  mission_governance: missionGovernanceContentSchema,
  history: historyContentSchema,
  products_roadmap: productsRoadmapContentSchema,
} as const;

export const dashboardDataSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  tab: dashboardTabSchema,
  contentJson: z.unknown(),
  lastRefreshedAt: isoTimestamp.nullable(),
});

// Reports & Research Threads ------------------------------------------------
export const citationSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const reportSchema = z.object({
  id: z.string(),
  kind: z.enum(['deck', 'company']),
  subjectId: z.string(),
  title: z.string(),
  markdown: z.string(),
  citations: z.array(citationSchema).default([]),
  createdAt: isoTimestamp,
});

export const researchScopeSchema = z.object({
  kind: z.enum(['deck', 'company', 'cards', 'datapoint']),
  deckId: z.string().nullable(),
  companyId: z.string().nullable().optional(),
  cardIds: z.array(z.string()).optional(),
  subject: z.string().nullable().optional(),
});

export const threadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  citations: z.array(citationSchema).default([]),
  at: isoTimestamp,
});

export const researchThreadSchema = z.object({
  id: z.string(),
  scope: researchScopeSchema,
  title: z.string(),
  messages: z.array(threadMessageSchema).default([]),
  reportId: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

// Repo Snapshot for Brain Import / Export -----------------------------------
export const repoSnapshotSchema = z.object({
  markets: z.array(marketSchema).default([]),
  decks: z.array(deckSchema).default([]),
  companies: z.array(companySchema).default([]),
  metrics: z.array(companyMetricSchema).default([]),
  cards: z.array(cardSchema).default([]),
  viceClaims: z.array(viceClaimSchema).default([]),
  reports: z.array(reportSchema).default([]),
  threads: z.array(researchThreadSchema).default([]),
});

export interface ParsedRepoSnapshotResult {
  snapshot: z.infer<typeof repoSnapshotSchema>;
  totalItems: number;
  validItems: number;
  skippedItems: number;
  warnings: string[];
}

export function parseRepoSnapshot(raw: unknown): ParsedRepoSnapshotResult {
  if (typeof raw !== 'object' || raw === null) {
    return {
      snapshot: {
        markets: [],
        decks: [],
        companies: [],
        metrics: [],
        cards: [],
        viceClaims: [],
        reports: [],
        threads: [],
      },
      totalItems: 0,
      validItems: 0,
      skippedItems: 0,
      warnings: ['Invalid JSON snapshot format: root must be an object.'],
    };
  }

  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];
  let totalItems = 0;
  let validItems = 0;
  let skippedItems = 0;

  function parseCollection<T extends z.ZodTypeAny>(
    key: string,
    schema: T,
  ): z.infer<T>[] {
    const rawList = Array.isArray(obj[key]) ? (obj[key] as unknown[]) : [];
    totalItems += rawList.length;
    const result: z.infer<T>[] = [];
    let skipped = 0;

    for (const item of rawList) {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        result.push(parsed.data);
        validItems++;
      } else {
        skipped++;
        skippedItems++;
      }
    }

    if (skipped > 0) {
      warnings.push(`Skipped ${skipped} invalid item(s) in '${key}'.`);
    }

    return result;
  }

  const snapshot = {
    markets: parseCollection('markets', marketSchema),
    decks: parseCollection('decks', deckSchema),
    companies: parseCollection('companies', companySchema),
    metrics: parseCollection('metrics', companyMetricSchema),
    cards: parseCollection('cards', cardSchema),
    viceClaims: parseCollection('viceClaims', viceClaimSchema),
    reports: parseCollection('reports', reportSchema),
    threads: parseCollection('threads', researchThreadSchema),
  };

  return {
    snapshot,
    totalItems,
    validItems,
    skippedItems,
    warnings,
  };
}
