/**
 * The agentic research pipeline (a typed task graph, not literal LangGraph —
 * same idea, dependency-free and running in browser + Electron):
 *
 *   interpret ─▶ discover ─▶ enrich (fan-out, concurrency-gated) ─▶ score ─▶ assemble
 *                        └─▶ barriers ────────────────────────────────────┘
 *
 * "Every card is a search query": discovery is one grounded search; each company
 * is a grounded search (enrich) + a structuring pass; barriers are a grounded
 * search. Nothing factual comes from training data — only from grounded results,
 * and every figure is tagged verified / estimated / unknown with a citation.
 */
import type { infer as ZodInfer } from 'zod';
import {
  buildCmsInput,
  computeCms,
  type BrandTheme,
  type Card,
  type CardType,
  type CardWithCompany,
  type Company,
  type CompanyMetric,
  type Deck,
  type Market,
  type MaturityTier,
  type MetricType,
  type ViceClaim,
  enforceMetricsProvenance,
  classifySource,
  isEntityCardType,
} from '@mi/contracts';
import {
  marketCardsOutSchema,
  discoveryMinimumOutSchema,
  discoveryOutSchema,
  enrichmentOutSchema,
  marketPlanOutSchema,
  tierReviewBatchOutSchema,
  tierReviewOutSchema,
  type EnrichmentOut,
} from './schemas';
import {
  GROUNDED_SYSTEM,
  STRUCTURE_SYSTEM,
  discoverPrompt,
  type DiscoveryFocus,
  enrichPrompt,
  interpretMarketPrompt,
  structureDiscoveryPrompt,
  structureEnrichPrompt,
  structureMarketPrompt,
  tierReviewBatchPrompt,
  tierReviewPrompt,
} from './prompts';
import type {
  Citation,
  CompanyCandidate,
  LlmClient,
  MarketPlan,
  OnResearchEvent,
  ResearchCoverage,
  RunResearchOptions,
} from './types';
import { faviconUrl, resolveLogo } from './logos';
import { mapWithConcurrency, rootDomain, slugify, throwIfAborted } from './util';

export interface ResearchResult {
  market: Market;
  deck: Deck;
  cards: CardWithCompany[];
}

const uid = (prefix: string, slug: string): string =>
  `${prefix}_${slug}_${Math.random().toString(36).slice(2, 7)}`;

const now = (): string => new Date().toISOString();

const DEFAULT_BRAND: BrandTheme = {
  primary: '#4f46e5',
  secondary: '#a5b4fc',
  accent: '#f59e0b',
  text: '#0f172a',
  background: '#ffffff',
  fontFamily: null,
  source: 'default',
};

function brandFrom(brand: EnrichmentOut['brand']): BrandTheme {
  if (!brand || !brand.primary || !brand.secondary || !brand.accent) {
    return DEFAULT_BRAND;
  }
  return {
    primary: brand.primary,
    secondary: brand.secondary,
    accent: brand.accent,
    text: '#0f172a',
    background: '#ffffff',
    fontFamily: null,
    source: 'scraped',
  };
}

function metricRows(
  enrich: EnrichmentOut,
  citations: Citation[],
  companyId: string,
): CompanyMetric[] {
  const rows: CompanyMetric[] = [];
  const cited = (idx: number | null | undefined): Citation[] =>
    idx != null && citations[idx] ? [citations[idx]!] : [];
  for (const [type, m] of Object.entries(enrich.metrics ?? {})) {
    if (!m) continue;
    const attached = cited(m.sourceIndex).map((citation) => ({
      ...citation,
      credibility: classifySource(citation.url, citation.title),
    }));
    rows.push({
      id: uid('met', `${companyId}-${type}`),
      companyId,
      metricType: type as MetricType,
      value: m.value ?? null,
      confidence: m.confidence ?? 'unknown',
      source: attached[0]?.url ?? null,
      citations: attached,
      methodNote: m.method ?? null,
      capturedAt: now(),
    });
  }
  // The model may claim "verified" while pointing at nothing. Provenance rules
  // decide the final confidence — evidence, not assertion. (Audit 2026-07-29:
  // 3 of 29 "verified" figures had no source at all.)
  return enforceMetricsProvenance(rows);
}

interface EnrichedCompany {
  candidate: CompanyCandidate;
  company: Company;
  metrics: CompanyMetric[];
  enrich: EnrichmentOut;
  citations: Citation[];
}

async function interpret(
  client: LlmClient,
  brief: { prompt: string; region: string | null },
  signal?: AbortSignal,
): Promise<MarketPlan> {
  const grounded = await client.ground(interpretMarketPrompt(brief.prompt, brief.region), {
    system: GROUNDED_SYSTEM,
    signal,
  });
  const plan = await client.structure(structureMarketPrompt(grounded.text), marketPlanOutSchema, {
    system: STRUCTURE_SYSTEM,
    signal,
  });
  return {
    marketName: plan.marketName,
    vertical: plan.vertical,
    geography: plan.geography ?? brief.region,
    notes: plan.notes,
    searchThemes: plan.searchThemes,
  };
}

function identityKeys(name: string, domain: string | null): string[] {
  const nameKey = name
    .toLowerCase()
    .replace(
      /\b(incorporated|corporation|company|limited|holdings|group|inc|llc|ltd|corp|plc|ag)\b/g,
      '',
    )
    .replace(/[^a-z0-9]/g, '');
  const domainKey = domain ? rootDomain(domain) : null;
  return [nameKey, ...(domainKey ? [domainKey] : [])];
}

function primaryEntityType(
  cardTypes: CardType[],
  name = '',
  descriptor = '',
  explicitRole?: 'company' | 'infrastructure' | 'distribution',
): 'company' | 'infrastructure' | 'distribution' {
  if (explicitRole) return explicitRole;
  const roles = cardTypes.filter(
    (type): type is 'company' | 'infrastructure' | 'distribution' =>
      type === 'company' || type === 'infrastructure' || type === 'distribution',
  );
  if (roles.length <= 1) return roles[0] ?? 'company';
  const text = `${name} ${descriptor}`.toLowerCase();
  if (/marketplace|reseller|integrator|channel|retailer|store|distribution|model hub/.test(text))
    return 'distribution';
  if (/lab|foundation model|research|model developer|ai company|generative/.test(text))
    return 'company';
  if (
    /chip|gpu|compute|cloud|hardware|infrastructure|hosting|platform|data center|datacenter/.test(
      text,
    )
  )
    return 'infrastructure';
  return 'company';
}

const DEFAULT_COVERAGE: ResearchCoverage = {
  companies: { min: 10, target: 12, max: 20 },
  infrastructure: { min: 4, target: 6, max: 10 },
  distribution: { min: 2, target: 4, max: 10 },
  vice: { min: 4, target: 4, max: 10 },
  culture: { min: 4, target: 4, max: 10 },
  barrier: { min: 4, target: 6, max: 10 },
  insight: { min: 4, target: 6, max: 10 },
};

function resolveCoverage(options: RunResearchOptions): ResearchCoverage {
  const requested = options.coverage ?? {};
  const companies = requested.companies ?? DEFAULT_COVERAGE.companies;
  // The legacy option is a total entity target. Keep it as a safe override for
  // callers, but never let it reduce the hard company minimum.
  const targetCompanies = Math.max(options.targetCompanies ?? companies.target, companies.min);
  return {
    ...DEFAULT_COVERAGE,
    ...requested,
    companies: {
      ...companies,
      target: targetCompanies,
      max: Math.max(companies.max, targetCompanies),
    },
  };
}

async function discover(
  client: LlmClient,
  plan: MarketPlan,
  target: number,
  signal?: AbortSignal,
  focus: DiscoveryFocus = 'all',
  excludeNames: string[] = [],
  searchAngle?: string,
): Promise<{ candidates: CompanyCandidate[]; rejected: string[] }> {
  const grounded = await client.ground(
    discoverPrompt(plan, target, focus, excludeNames, searchAngle),
    {
      system: GROUNDED_SYSTEM,
      signal,
    },
  );
  const structureOptions = { system: STRUCTURE_SYSTEM, signal };
  let out: { companies: ZodInfer<typeof discoveryOutSchema>['companies'] };
  if (focus === 'all' && target >= 10) {
    try {
      // The primary schema is intentionally strict: a successful primary pass is
      // already guaranteed to contain ten unique companies. Underfill is handled
      // by the bounded fallback below rather than by inventing rows.
      out = await client.structure(
        structureDiscoveryPrompt(grounded.text, focus),
        discoveryMinimumOutSchema,
        structureOptions,
      );
    } catch {
      out = await client.structure(
        structureDiscoveryPrompt(grounded.text, focus),
        discoveryOutSchema,
        structureOptions,
      );
    }
  } else {
    out = await client.structure(
      structureDiscoveryPrompt(grounded.text, focus),
      discoveryOutSchema,
      structureOptions,
    );
  }
  const seen = new Set(excludeNames.flatMap((name) => identityKeys(name, null)));
  const candidates: CompanyCandidate[] = [];
  const rejected: string[] = [];
  for (const c of out.companies ?? []) {
    const name = c.name.trim();
    const domain = rootDomain(c.domain);
    const keys = identityKeys(name, domain);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    const rawTypes = (c.cardTypes ?? []) as CardType[];
    const cardTypes: CardType[] = rawTypes.filter((t) => t !== 'barrier' && t !== 'insight');

    // A signal-only candidate is valid only when it resolves to a real operating
    // entity. Otherwise it is a topic dressed as a company and is rejected.
    let facets = cardTypes;
    if (facets.length > 0 && !facets.some(isEntityCardType)) {
      if (!domain) {
        rejected.push(name);
        continue;
      }
      facets = ['company', ...facets];
    }
    if (focus !== 'all' && !facets.includes(focus as CardType)) continue;
    const descriptor = c.descriptor ?? '';
    const focusRole =
      focus === 'company' || focus === 'infrastructure' || focus === 'distribution'
        ? focus
        : undefined;
    const primaryRole = c.primaryRole ?? primaryEntityType(facets, name, descriptor, focusRole);
    if (!facets.includes(primaryRole)) facets = [primaryRole, ...facets];

    candidates.push({
      name,
      domain,
      descriptor,
      primaryRole,
      cardTypes: facets.length ? facets : ['company'],
    });
  }
  return { candidates, rejected };
}

function mergeCandidates(
  existing: CompanyCandidate[],
  additions: CompanyCandidate[],
): CompanyCandidate[] {
  const seen = new Set(existing.flatMap((c) => identityKeys(c.name, c.domain)));
  const merged = [...existing];
  for (const candidate of additions) {
    const keys = identityKeys(candidate.name, candidate.domain);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    merged.push(candidate);
  }
  return merged;
}

export function selectCandidates(
  candidates: CompanyCandidate[],
  coverage: ResearchCoverage,
  maxCandidates = Number.POSITIVE_INFINITY,
): CompanyCandidate[] {
  const roles = ['company', 'infrastructure', 'distribution'] as const;
  const roleCoverage = {
    company: coverage.companies,
    infrastructure: coverage.infrastructure,
    distribution: coverage.distribution,
  };
  const groups = new Map(
    roles.map((role) => [
      role,
      candidates.filter(
        (c) => primaryEntityType(c.cardTypes, c.name, c.descriptor, c.primaryRole) === role,
      ),
    ]),
  );
  const selected: CompanyCandidate[] = [];
  for (const role of roles)
    selected.push(...(groups.get(role) ?? []).slice(0, roleCoverage[role].min));
  for (const role of roles) {
    const current = groups.get(role) ?? [];
    const already = new Set(selected.map((c) => identityKeys(c.name, c.domain)[0]));
    for (const candidate of current.slice(roleCoverage[role].min, roleCoverage[role].target)) {
      if (!already.has(identityKeys(candidate.name, candidate.domain)[0])) {
        selected.push(candidate);
        already.add(identityKeys(candidate.name, candidate.domain)[0]);
      }
    }
  }
  // Preserve signal-bearing entities while selecting the entity quotas. Signals
  // are facets on a company card, so dropping these candidates would make the
  // vice/culture minimum impossible even when discovery found credible evidence.
  for (const signalRole of ['vice', 'culture'] as const) {
    let count = selected.filter((c) => c.cardTypes.includes(signalRole)).length;
    if (count >= coverage[signalRole].min) continue;
    for (const candidate of candidates) {
      if (count >= coverage[signalRole].min) break;
      if (!candidate.cardTypes.includes(signalRole)) continue;
      const key = identityKeys(candidate.name, candidate.domain)[0]!;
      if (selected.some((c) => identityKeys(c.name, c.domain)[0] === key)) continue;
      selected.push(candidate);
      count += 1;
    }
  }
  const selectedKeys = new Set(
    selected.flatMap((candidate) => identityKeys(candidate.name, candidate.domain)),
  );
  for (const candidate of candidates) {
    if (selected.length >= maxCandidates) break;
    const keys = identityKeys(candidate.name, candidate.domain);
    if (keys.some((key) => selectedKeys.has(key))) continue;
    keys.forEach((key) => selectedKeys.add(key));
    selected.push(candidate);
  }
  return selected;
}

export async function discoverWithCoverage(
  client: LlmClient,
  plan: MarketPlan,
  coverage: ResearchCoverage,
  signal?: AbortSignal,
  catalogMax = 50,
  catalogPasses = plan.searchThemes.length,
): Promise<{
  candidates: CompanyCandidate[];
  rejected: string[];
  minimumCompaniesSatisfied: boolean;
}> {
  let candidates: CompanyCandidate[] = [];
  const rejected: string[] = [];
  const initial = await discover(
    client,
    plan,
    Math.min(
      catalogMax,
      coverage.companies.target + coverage.infrastructure.target + coverage.distribution.target,
    ),
    signal,
  );
  candidates = mergeCandidates(candidates, initial.candidates);
  rejected.push(...initial.rejected);

  const countRole = (role: 'company' | 'infrastructure' | 'distribution') =>
    candidates.filter(
      (c) => primaryEntityType(c.cardTypes, c.name, c.descriptor, c.primaryRole) === role,
    ).length;
  const countSignal = (role: 'vice' | 'culture') =>
    candidates.filter((c) => c.cardTypes.includes(role)).length;
  const fallbackPasses: { role: DiscoveryFocus; needed: number; target: number }[] = [
    { role: 'company', needed: coverage.companies.min, target: coverage.companies.target },
    {
      role: 'infrastructure',
      needed: coverage.infrastructure.min,
      target: coverage.infrastructure.target,
    },
    {
      role: 'distribution',
      needed: coverage.distribution.min,
      target: coverage.distribution.target,
    },
    { role: 'vice', needed: coverage.vice.min, target: coverage.vice.target },
    { role: 'culture', needed: coverage.culture.min, target: coverage.culture.target },
  ];
  const neededPasses = fallbackPasses.filter((pass) => {
    const current =
      pass.role === 'vice' || pass.role === 'culture'
        ? countSignal(pass.role)
        : countRole(pass.role as 'company' | 'infrastructure' | 'distribution');
    return current < pass.needed;
  });

  if (neededPasses.length > 0) {
    const fallbackResults = await Promise.all(
      neededPasses.map((pass) => {
        const current =
          pass.role === 'vice' || pass.role === 'culture'
            ? countSignal(pass.role)
            : countRole(pass.role as 'company' | 'infrastructure' | 'distribution');
        return discover(
          client,
          plan,
          Math.min(pass.target, pass.needed - current + 2),
          signal,
          pass.role,
          candidates.map((c) => c.name),
        );
      }),
    );
    for (const fallback of fallbackResults) {
      candidates = mergeCandidates(candidates, fallback.candidates);
      rejected.push(...fallback.rejected);
    }
  }

  // Catalog expansion searches each market angle independently only if candidates are under minimum
  if (candidates.length < coverage.companies.min) {
    let noGrowth = 0;
    for (const angle of plan.searchThemes.slice(0, catalogPasses)) {
      if (candidates.length >= catalogMax || noGrowth >= 2) break;
      const before = candidates.length;
      const pass = await discover(
        client,
        plan,
        Math.min(8, catalogMax - candidates.length),
        signal,
        'all',
        candidates.map((candidate) => candidate.name),
        angle,
      );
      candidates = mergeCandidates(candidates, pass.candidates);
      rejected.push(...pass.rejected);
      noGrowth = candidates.length === before ? noGrowth + 1 : 0;
    }
  }

  const selected = selectCandidates(candidates, coverage, catalogMax);
  const companyNames = selected
    .filter(
      (candidate) =>
        primaryEntityType(
          candidate.cardTypes,
          candidate.name,
          candidate.descriptor,
          candidate.primaryRole,
        ) === 'company',
    )
    .map((candidate) => identityKeys(candidate.name, candidate.domain)[0]);
  const minimumCompaniesSatisfied = new Set(companyNames).size >= coverage.companies.min;
  return { candidates: selected, rejected, minimumCompaniesSatisfied };
}

async function enrichOne(
  client: LlmClient,
  candidate: CompanyCandidate,
  plan: MarketPlan,
  signal?: AbortSignal,
): Promise<EnrichedCompany> {
  const grounded = await client.ground(enrichPrompt(candidate, plan), {
    system: GROUNDED_SYSTEM,
    signal,
  });
  const enrich = await client.structure(
    structureEnrichPrompt(candidate, grounded.text, grounded.citations),
    enrichmentOutSchema,
    { system: STRUCTURE_SYSTEM, signal },
  );
  const slug = slugify(candidate.name);
  const companyId = uid('cmp', slug);
  const website = enrich.website ?? (candidate.domain ? `https://${candidate.domain}` : null);
  const domain = rootDomain(website) ?? candidate.domain;
  const company: Company = {
    id: companyId,
    name: candidate.name,
    oneLiner: enrich.oneLiner || candidate.descriptor,
    logoUrl: faviconUrl(domain),
    hqLocation: enrich.hqLocation ?? null,
    websiteUrl: website,
    brandTheme: brandFrom(enrich.brand ?? null),
  };
  return {
    candidate,
    company,
    metrics: metricRows(enrich, grounded.citations, companyId),
    enrich,
    citations: grounded.citations,
  };
}

/**
 * Review the whole cohort's tiers in ONE call.
 *
 * Replaces one structure call per company (10 calls on a 10-company deck → 1).
 * That matters against a 15 RPM free-tier ceiling, and it makes the ranking
 * better: the model compares companies against each other rather than judging
 * each in isolation. Falls back to "no nudges" on any failure — the
 * deterministic base tier is always a valid answer.
 */
async function reviewTiersBatch(
  client: LlmClient,
  marketName: string,
  rows: { name: string; baseTier: MaturityTier; evidence: string }[],
  signal?: AbortSignal,
): Promise<Map<string, { nudge: -1 | 0 | 1; reason: string | null }>> {
  const out = new Map<string, { nudge: -1 | 0 | 1; reason: string | null }>();
  if (rows.length === 0) return out;
  try {
    const res = await client.structure(
      tierReviewBatchPrompt(marketName, rows),
      tierReviewBatchOutSchema,
      { system: STRUCTURE_SYSTEM, signal },
    );
    const byName = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.name]));
    for (const r of res.reviews ?? []) {
      const key = byName.get((r.name ?? '').trim().toLowerCase());
      if (key) out.set(key, { nudge: r.nudge ?? 0, reason: r.reason ?? null });
    }
  } catch {
    /* keep the deterministic tiers — a failed review must never fail the deck */
  }
  return out;
}

async function reviewTier(
  client: LlmClient,
  name: string,
  baseTier: MaturityTier,
  metrics: CompanyMetric[],
  signal?: AbortSignal,
): Promise<{ nudge: -1 | 0 | 1; reason: string | null }> {
  const evidence = metrics
    .map((m) => `${m.metricType}: ${m.value ?? 'unknown'} (${m.confidence})`)
    .join('; ');
  try {
    const out = await client.structure(
      tierReviewPrompt(name, baseTier, evidence),
      tierReviewOutSchema,
      { system: STRUCTURE_SYSTEM, signal },
    );
    return { nudge: out.nudge ?? 0, reason: out.reason ?? null };
  } catch {
    return { nudge: 0, reason: null };
  }
}

/**
 * Market-level cards: structural barriers to entry AND the non-obvious dynamics
 * worth remembering (Insight cards). One grounded call feeds both, so the second
 * card type costs nothing extra against the per-minute free-tier ceiling.
 *
 * Neither type belongs to a company, so neither mints one — the same discipline
 * the entity rule now enforces in discovery.
 */
async function researchMarketCards(
  client: LlmClient,
  plan: MarketPlan,
  deckId: string,
  signal?: AbortSignal,
): Promise<CardWithCompany[]> {
  const where = plan.geography ? ` in ${plan.geography}` : '';
  const runPass = async (focus: 'both' | 'barrier' | 'insight') => {
    const grounded = await client.ground(
      [
        `Using Google Search, research the market "${plan.marketName}" (${plan.vertical})${where}.`,
        focus === 'both' || focus === 'barrier'
          ? `BARRIERS — find at least 4 and up to 10 structural barriers to entry: regulatory, capital intensity, network effects, brand trust, or supply chain.`
          : ``,
        focus === 'both' || focus === 'insight'
          ? `INSIGHTS — find at least 4 and up to 10 non-obvious dynamics from roughly the last 3-6 months that a smart operator would want to know: a shift underway, a counter-intuitive pattern, or a mismatch between perception and reality.`
          : ``,
        `Ground every point in what you actually find. Do not speculate or pad the list with generic claims.`,
      ]
        .filter(Boolean)
        .join('\n'),
      { system: GROUNDED_SYSTEM, signal },
    );
    const out = await client.structure(
      [
        `From the notes, output JSON { "barriers": [ { "title", "summary", "sourceIndex", "keyPoints" } ], "insights": [ { "title", "summary", "sourceIndex", "keyPoints" } ] }.`,
        `Return 4-10 distinct sourced items for each requested category. If the notes do not support four, return fewer rather than inventing.`,
        `"sourceIndex" is the 0-based index of the source that supports the point, or null if none of the listed sources do.`,
        `"keyPoints" is 4-8 short entries (1-2 sentences each) carrying the substance behind the headline — concrete specifics drawn ONLY from the notes: figures, named companies, dates, mechanisms. No filler.`,
        ``,
        `SOURCES:`,
        grounded.citations.map((c, i) => `[${i}] ${c.title} — ${c.url}`).join('\n') || '(none)',
        ``,
        `NOTES:`,
        grounded.text,
      ]
        .filter(Boolean)
        .join('\n'),
      marketCardsOutSchema,
      { system: STRUCTURE_SYSTEM, signal },
    );
    return { out, citations: grounded.citations };
  };
  const first = await runPass('both');
  const barrierCount = first.out.barriers?.length ?? 0;
  const insightCount = first.out.insights?.length ?? 0;
  const second =
    barrierCount < 4 || insightCount < 4
      ? await runPass(
          barrierCount < 4 && insightCount < 4 ? 'both' : barrierCount < 4 ? 'barrier' : 'insight',
        )
      : null;
  const citations = [...first.citations, ...(second?.citations ?? [])];
  const offsetClaims = <T extends { sourceIndex: number | null }>(
    claims: T[],
    offset: number,
  ): T[] =>
    claims.map((claim) => ({
      ...claim,
      sourceIndex: claim.sourceIndex == null ? null : claim.sourceIndex + offset,
    }));
  const dedupeClaims = <T extends { title: string }>(claims: T[]): T[] => {
    const seen = new Set<string>();
    return claims
      .filter((claim) => {
        const key = claim.title
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  };
  const out = {
    barriers: dedupeClaims([
      ...(first.out.barriers ?? []),
      ...offsetClaims(second?.out.barriers ?? [], first.citations.length),
    ]),
    insights: dedupeClaims([
      ...(first.out.insights ?? []),
      ...offsetClaims(second?.out.insights ?? [], first.citations.length),
    ]),
  };

  const build = (
    claim: { title: string; summary: string; sourceIndex: number | null; keyPoints: string[] },
    cardType: 'barrier' | 'insight',
  ): CardWithCompany | null => {
    const cited = claim.sourceIndex != null ? citations[claim.sourceIndex] : undefined;
    // A market signal without a supporting citation is not a useful card. Drop it
    // rather than letting polished UI imply that an unsupported claim is research.
    if (!cited?.url) return null;
    const evidence = [{ ...cited, credibility: classifySource(cited.url, cited.title) }];
    return {
      card: {
        id: uid('crd', `${slugify(claim.title)}-${cardType}`),
        deckId,
        companyId: null,
        cardType,
        title: claim.title,
        summary: claim.summary,
        tier: null,
        tierReason: null,
        citations: evidence,
        keyPoints: claim.keyPoints ?? [],
        createdAt: now(),
      },
      company: null,
      metrics: [],
      viceClaims: [],
    };
  };

  return [
    ...(out.barriers ?? []).map((barrier) => build(barrier, 'barrier')),
    ...(out.insights ?? []).map((insight) => build(insight, 'insight')),
  ].filter((card): card is CardWithCompany => card !== null);
}

/**
 * Targeted micro-research to fill a gap in an existing deck (intelligent empty
 * states): one focused grounded discovery + enrichment for a tier or card type.
 * Returns fully-assembled cards; the caller stamps deckId and ingests.
 */
export async function expandDeckResearch(args: {
  client: LlmClient;
  marketName: string;
  vertical: string;
  geography: string | null;
  focusPrompt: string;
  excludeNames: string[];
  deckId: string;
  deckUserValues: number[];
  target?: number;
  onEvent?: OnResearchEvent;
  signal?: AbortSignal;
}): Promise<CardWithCompany[]> {
  const emit: OnResearchEvent = args.onEvent ?? (() => {});
  const plan: MarketPlan = {
    marketName: args.marketName,
    vertical: args.vertical,
    geography: args.geography,
    notes: null,
    searchThemes: [args.focusPrompt],
  };
  emit({ type: 'status', step: 'discover', message: `Hunting: ${args.focusPrompt}` });
  const grounded = await args.client.ground(
    [
      `Market: ${plan.marketName} — ${plan.vertical}${plan.geography ? ` in ${plan.geography}` : ''}.`,
      `Using Google Search, find up to ${args.target ?? 3} REAL companies matching this focus: ${args.focusPrompt}.`,
      `Exclude these already-known companies: ${args.excludeNames.join(', ') || '(none)'}.`,
      `STRICT: only actual operating companies — no agencies, regulators, trade bodies, or concepts.`,
    ].join('\n'),
    { system: GROUNDED_SYSTEM, signal: args.signal },
  );
  const out = await args.client.structure(
    structureDiscoveryPrompt(grounded.text),
    discoveryOutSchema,
    { system: STRUCTURE_SYSTEM, signal: args.signal },
  );
  const known = new Set(args.excludeNames.map((n) => n.toLowerCase()));
  const candidates: CompanyCandidate[] = (out.companies ?? [])
    .filter((c) => !known.has(c.name.trim().toLowerCase()))
    .slice(0, args.target ?? 3)
    .map((c) => ({
      name: c.name.trim(),
      domain: rootDomain(c.domain),
      descriptor: c.descriptor ?? '',
      cardTypes: ['company'],
    }));
  emit({ type: 'candidates', candidates });

  const cards: CardWithCompany[] = [];
  for (const candidate of candidates) {
    throwIfAborted(args.signal);
    const e = await enrichOne(args.client, candidate, plan, args.signal);
    emit({ type: 'status', step: 'enrich', message: `Researched ${candidate.name}` });
    const base = computeCms(buildCmsInput(e.metrics), { deckUserValues: args.deckUserValues });
    let tier: MaturityTier | null = base.finalTier;
    let tierReason: string | null = null;
    if (base.finalTier != null) {
      const review = await reviewTier(
        args.client,
        e.company.name,
        base.finalTier,
        e.metrics,
        args.signal,
      );
      tier = computeCms(
        buildCmsInput(e.metrics),
        { deckUserValues: args.deckUserValues },
        { nudge: review.nudge },
      ).finalTier;
      tierReason = review.reason;
    }
    const card: Card = {
      id: uid('crd', `${slugify(e.company.name)}-company`),
      deckId: args.deckId,
      companyId: e.company.id,
      cardType: 'company',
      title: null,
      summary: null,
      tier,
      tierReason,
      citations: [],
      keyPoints: [],
      createdAt: now(),
    };
    const cwc: CardWithCompany = { card, company: e.company, metrics: e.metrics, viceClaims: [] };
    cards.push(cwc);
    emit({ type: 'card', card: cwc });
  }
  return cards;
}

/** Run the full deck-research pipeline. Streams progress via `onEvent`. */
export async function runDeckResearch(
  brief: { prompt: string; region: string | null },
  client: LlmClient,
  options: RunResearchOptions,
): Promise<ResearchResult> {
  const emit: OnResearchEvent = options.onEvent ?? (() => {});
  const signal = options.signal;
  const coverage = resolveCoverage(options);
  // Keep the default deterministic and sequential. The Gemini client still paces
  // every request, but serial enrichment gives the queue a clear next item and
  // prevents a broad market from bursting the free-tier window.
  const concurrency = options.concurrency ?? 1;
  let plan: MarketPlan;
  let candidates: CompanyCandidate[];
  let rejected: string[] = [];
  let minimumCompaniesSatisfied = true;
  let market: Market;
  let deck: Deck;
  let completedCards: CardWithCompany[] = [];

  if (options.resume) {
    plan = options.resume.plan;
    market = options.resume.market;
    deck = options.resume.deck;
    completedCards = [...options.resume.completedCards];
    candidates = [...options.resume.candidates];
    const completedNames = new Set(
      completedCards
        .filter((entry) => entry.company)
        .map((entry) => entry.company!.name.toLowerCase()),
    );
    candidates = candidates.filter(
      (candidate) => !completedNames.has(candidate.name.toLowerCase()),
    );
    emit({
      type: 'status',
      step: 'enrich',
      message: `Resuming research with ${candidates.length} remaining players…`,
    });
    emit({ type: 'market', market: plan });
    emit({ type: 'candidates', candidates: [...options.resume.candidates] });
  } else {
    emit({ type: 'status', step: 'interpret', message: 'Understanding the market…' });
    plan = await interpret(client, brief, signal);
    emit({ type: 'market', market: plan });

    emit({
      type: 'status',
      step: 'discover',
      message: 'Discovering companies via grounded search…',
    });
    const discovery = await discoverWithCoverage(
      client,
      plan,
      coverage,
      signal,
      options.catalogMax ?? 50,
      options.catalogPasses ?? plan.searchThemes.length,
    );
    candidates = discovery.candidates;
    rejected = discovery.rejected;
    minimumCompaniesSatisfied = discovery.minimumCompaniesSatisfied;
    if (rejected.length > 0) {
      emit({
        type: 'warning',
        message: `Skipped ${rejected.length} result${rejected.length === 1 ? '' : 's'} that ${rejected.length === 1 ? 'was' : 'were'} a topic rather than a company: ${rejected.join(', ')}.`,
      });
    }
    if (!minimumCompaniesSatisfied) {
      emit({
        type: 'warning',
        message: `Primary discovery remained below the ${coverage.companies.min}-company minimum after bounded fallback passes. The deck will continue with sourced entities only.`,
      });
    }
    const roleCounts = {
      company: candidates.filter(
        (c) => primaryEntityType(c.cardTypes, c.name, c.descriptor, c.primaryRole) === 'company',
      ).length,
      infrastructure: candidates.filter(
        (c) =>
          primaryEntityType(c.cardTypes, c.name, c.descriptor, c.primaryRole) === 'infrastructure',
      ).length,
      distribution: candidates.filter(
        (c) =>
          primaryEntityType(c.cardTypes, c.name, c.descriptor, c.primaryRole) === 'distribution',
      ).length,
      vice: candidates.filter((c) => c.cardTypes.includes('vice')).length,
      culture: candidates.filter((c) => c.cardTypes.includes('culture')).length,
    };
    for (const [role, count] of Object.entries(roleCounts)) {
      const minimum = coverage[role as keyof typeof coverage]?.min;
      if (minimum != null && count < minimum) {
        emit({
          type: 'warning',
          message: `Coverage shortfall for ${role}: found ${count}, minimum is ${minimum}. No unsupported entities were invented.`,
        });
      }
    }
    emit({ type: 'candidates', candidates });

    const marketSlug = slugify(plan.marketName);
    market = {
      id: uid('mkt', marketSlug),
      name: plan.marketName,
      scopeDefinition: { vertical: plan.vertical, geography: plan.geography, notes: plan.notes },
      refreshCadence: 'weekly',
      createdAt: now(),
    };
    deck = {
      id: uid('dck', marketSlug),
      marketId: market.id,
      createdAt: now(),
      lastRefreshedAt: now(),
    };
  }

  // Summary + headline metrics are one grounded pass per player. The queue is
  // sequential by default, so the next player is explicit and rate-limit-safe.
  emit({
    type: 'status',
    step: 'enrich',
    message: 'Researching company summaries and headline metrics in sequence…',
  });
  let done = 0;
  const enriched = (
    await mapWithConcurrency(
      candidates,
      concurrency,
      async (candidate) => {
        throwIfAborted(signal);
        try {
          const result = await enrichOne(client, candidate, plan, signal);
          done += 1;
          emit({
            type: 'status',
            step: 'enrich',
            message: `Researched ${candidate.name} (${done}/${candidates.length})`,
            progress: done / candidates.length,
          });
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          emit({
            type: 'warning',
            message: `Could not enrich ${candidate.name}; preserving the rest of the deck. ${error instanceof Error ? error.message : 'Research failed.'}`,
          });
          return null;
        }
      },
      signal,
    )
  ).filter((entry): entry is EnrichedCompany => entry !== null);

  // Score: relative user values need the whole deck first.
  const allMetrics = [
    ...completedCards.flatMap((card) => card.metrics),
    ...enriched.flatMap((entry) => entry.metrics),
  ];
  const deckUserValues = allMetrics
    .filter(
      (metric) =>
        metric.metricType === 'users' && metric.confidence !== 'unknown' && metric.value !== null,
    )
    .map((metric) => metric.value as number);

  // Resolve logos ONCE here rather than probing per card at render time (audit
  // findings 2.2 / 3.1 / 3.3). Free, keyless, paced, and prefers vector art.
  emit({ type: 'status', step: 'score', message: 'Resolving company logos…' });
  await mapWithConcurrency(enriched, 2, async (e) => {
    try {
      const domain = rootDomain(e.company.websiteUrl) ?? e.candidate.domain;
      const logo = await resolveLogo({ name: e.company.name, domain }, { signal });
      if (logo.url) e.company.logoUrl = logo.url;
    } catch (error) {
      if (signal?.aborted) throw error;
      emit({ type: 'warning', message: `Logo lookup skipped for ${e.company.name}.` });
    }
    return null;
  });

  emit({ type: 'status', step: 'score', message: 'Scoring maturity tiers…' });

  // Deterministic base tiers first, then ONE cohort-wide review pass.
  const baseTiers = new Map<string, MaturityTier>();
  const reviewRows: { name: string; baseTier: MaturityTier; evidence: string }[] = [];
  for (const e of enriched) {
    // Any company with an entity facet gets a maturity tier — a business whose
    // primary role is "infrastructure" still has a size and a stage.
    if (!e.candidate.cardTypes.some(isEntityCardType)) continue;
    const base = computeCms(buildCmsInput(e.metrics), { deckUserValues });
    if (base.finalTier == null) continue;
    baseTiers.set(e.company.id, base.finalTier);
    reviewRows.push({
      name: e.company.name,
      baseTier: base.finalTier,
      evidence: e.metrics
        .map((m) => `${m.metricType}: ${m.value ?? 'unknown'} (${m.confidence})`)
        .join('; '),
    });
  }
  const reviews = await reviewTiersBatch(client, plan.marketName, reviewRows, signal);

  const cards: CardWithCompany[] = [...completedCards];
  for (const e of enriched) {
    let tier: MaturityTier | null = null;
    let tierReason: string | null = null;
    if (e.candidate.cardTypes.some(isEntityCardType) && baseTiers.has(e.company.id)) {
      const review = reviews.get(e.company.name) ?? { nudge: 0 as const, reason: null };
      const scored = computeCms(
        buildCmsInput(e.metrics),
        { deckUserValues },
        { nudge: review.nudge },
      );
      tier = scored.finalTier;
      tierReason = review.reason;
    }
    // Every sourced controversy this company actually has. Computed once, because
    // it decides whether a Vice card is worth minting at all.
    const sourcedViceClaims: ViceClaim[] = e.enrich.viceClaims
      .map((vc, i) => {
        const cite = vc.sourceIndex != null ? e.citations[vc.sourceIndex] : undefined;
        if (!cite?.url) return null; // grounding discipline: drop unsourced vice claims
        return {
          id: uid('vcl', `${e.company.id}-${i}`),
          cardId: '',
          claimText: vc.text,
          sourceUrl: cite.url,
          sourceTitle: cite.title || null,
          capturedAt: now(),
        };
      })
      .filter((x): x is ViceClaim => x !== null);
    const cultureNote = (e.enrich.cultureNote ?? '').trim();

    // ONE entity card per company, plus a signal card only where a signal exists.
    //
    // Discovery legitimately reports several roles for one business — OpenAI sells
    // models, rents inference, and distributes through a hyperscaler. But minting
    // a card per role printed the SAME four figures three times under three
    // headings, which is the duplication the entity rule was written to stop, and
    // it padded a 17-card deck to 47. The deck is "one card per company"; the
    // company's other roles are a property of that card, not extra cards.
    //
    // Signal facets are then emitted only when they carry content. A Vice card
    // with no sourced claim, or a Culture card with no note, is an empty promise —
    // measured on a live run: 10 of 10 companies were tagged culture or vice, and
    // every one of those cards came back with nothing in it.
    // Discovery is asked for exactly one role, so this is a tiebreak. Prefer the
    // more specific supplier roles: "company" is the label a model reaches for by
    // default, and letting it win would leave the Infrastructure and Distribution
    // views permanently empty.
    const primaryEntity = primaryEntityType(
      e.candidate.cardTypes,
      e.candidate.name,
      e.candidate.descriptor,
      e.candidate.primaryRole,
    );
    const emitted: CardType[] = [primaryEntity];
    if (e.candidate.cardTypes.includes('vice') && sourcedViceClaims.length > 0)
      emitted.push('vice');
    if (e.candidate.cardTypes.includes('culture') && cultureNote.length > 0)
      emitted.push('culture');

    for (const cardType of emitted) {
      const viceClaims: ViceClaim[] = cardType === 'vice' ? sourcedViceClaims : [];
      const card: Card = {
        id: uid('crd', `${slugify(e.company.name)}-${cardType}`),
        deckId: deck.id,
        companyId: e.company.id,
        cardType,
        title: null,
        summary: cardType === 'culture' ? cultureNote : null,
        tier: cardType === primaryEntity ? tier : null,
        tierReason: cardType === primaryEntity ? tierReason : null,
        citations: [],
        keyPoints: [],
        createdAt: now(),
      };
      const stampedClaims = viceClaims.map((v) => ({ ...v, cardId: card.id }));
      const cwc: CardWithCompany = {
        card,
        company: e.company,
        // Only a card that IS the business carries the business's figures. A
        // signal card states a sourced claim; lending it a valuation would show
        // the same number twice under two different provenance stories.
        metrics: isEntityCardType(cardType) ? e.metrics : [],
        viceClaims: stampedClaims,
      };
      cards.push(cwc);
      emit({ type: 'card', card: cwc });
    }
  }

  emit({ type: 'status', step: 'barriers', message: 'Identifying barriers and market insights…' });
  try {
    const marketCards = await researchMarketCards(client, plan, deck.id, signal);
    for (const cardType of ['barrier', 'insight'] as const) {
      const count = marketCards.filter((card) => card.card.cardType === cardType).length;
      if (count < coverage[cardType].min) {
        emit({
          type: 'warning',
          message: `Coverage shortfall for ${cardType}: found ${count}, minimum is ${coverage[cardType].min}. No unsupported market claims were invented.`,
        });
      }
    }
    for (const b of marketCards) {
      cards.push(b);
      emit({ type: 'card', card: b });
    }
  } catch {
    emit({ type: 'warning', message: 'Could not research market-level barriers and insights.' });
  }

  emit({ type: 'done', total: cards.length });
  return { market, deck, cards };
}

export interface Stage1DeckResearch {
  plan: MarketPlan;
  market: Market;
  deck: Deck;
  candidates: CompanyCandidate[];
  rejected: string[];
}

export async function prepareDeckResearch(
  brief: { prompt: string; region: string | null },
  client: LlmClient,
  options: RunResearchOptions = {},
): Promise<Stage1DeckResearch> {
  const signal = options.signal;
  const coverage = resolveCoverage(options);
  const plan = await interpret(client, brief, signal);
  const discovery = await discoverWithCoverage(
    client,
    plan,
    coverage,
    signal,
    options.catalogMax ?? 50,
    options.catalogPasses ?? plan.searchThemes.length,
  );
  const marketSlug = slugify(plan.marketName);
  const market: Market = {
    id: uid('mkt', marketSlug),
    name: plan.marketName,
    scopeDefinition: { vertical: plan.vertical, geography: plan.geography, notes: plan.notes },
    refreshCadence: 'weekly',
    createdAt: now(),
  };
  const deck: Deck = {
    id: uid('dck', marketSlug),
    marketId: market.id,
    createdAt: now(),
    lastRefreshedAt: now(),
  };

  return {
    plan,
    market,
    deck,
    candidates: discovery.candidates,
    rejected: discovery.rejected,
  };
}

export async function runDeckResearchFromStage1(
  stage: Stage1DeckResearch,
  client: LlmClient,
  options: RunResearchOptions = {},
): Promise<ResearchResult> {
  return runDeckResearch(
    { prompt: stage.plan.marketName, region: stage.plan.geography },
    client,
    {
      ...options,
      resume: {
        plan: stage.plan,
        market: stage.market,
        deck: stage.deck,
        candidates: stage.candidates,
        completedCards: [],
      },
    },
  );
}
