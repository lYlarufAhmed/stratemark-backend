/**
 * GeminiRepository — a full MarketIntelRepository backed by the live research
 * pipeline. Deck creation runs grounded research; dashboard tabs are researched
 * lazily on first open and cached. State persists through a pluggable store
 * (localStorage in the web app; SQLite/electron-store later). Because it
 * satisfies the same interface as MockRepository, the app swaps to it simply by
 * having an API key present — no UI changes.
 */
import {
  buildCmsInput,
  computeCms,
  reconcileMetrics,
  usableCitations,
  CARD_TYPE_DESCRIPTIONS,
  TIER_BLURBS,
  TIER_LABELS,
  type Card,
  type CardFilter,
  type CardWithCompany,
  type Company,
  type CompanyMetric,
  type CreateMarketInput,
  type ExpandFocus,
  type OverrideMetricInput,
  type DashboardTab,
  type DashboardTabResult,
  type DeepDiveInput,
  type DeepDiveResult,
  type FactCheckInput,
  type FactCheckResult,
  type Report,
  type ReportRequest,
  type SavedCard,
  type Deck,
  type DeckRefreshEvent,
  type DeckRefreshListener,
  type DeckResearchBrief,
  type Market,
  type MarketIntelRepository,
  type RefreshCadence,
  type ResearchHandlers,
  type ResearchJob,
  type ResearchStage,
  type AskResearchInput,
  type ResearchScope,
  type ResearchThread,
  type Unsubscribe,
  type ViceClaim,
} from '@mi/contracts';
import { createGeminiClient, type GeminiClientConfig } from './gemini';
import { researchDashboardTab } from './dashboard';
import { expandDeckResearch, runDeckResearch, type ResearchResult } from './pipeline';
import { CHAT_SYSTEM, GROUNDED_SYSTEM, STRUCTURE_SYSTEM } from './prompts';
import { factCheckOutSchema } from './schemas';
import type { LlmClient, ResearchCoverage, RunResearchOptions } from './types';

interface CachedTab {
  content: unknown;
  lastRefreshedAt: string;
}

export interface RepoSnapshot {
  markets: Market[];
  decks: Deck[];
  companies: Company[];
  metrics: CompanyMetric[];
  cards: Card[];
  viceClaims: ViceClaim[];
  dashboards: Record<string, Partial<Record<DashboardTab, CachedTab>>>;
  companyMarket: Record<string, string>;
  reports: Report[];
  savedCards: SavedCard[];
  /** marketId → cached whitespace analysis. */
  opportunity: Record<
    string,
    { markdown: string; citations: { title: string; url: string }[]; at: string }
  >;
  /** Active and completed research jobs, checkpointed for recovery and audit. */
  researchJobs: ResearchJob[];
  /**
   * Research conversations — the analyst's accumulated questions and grounded
   * answers, anchored to decks/companies/cards. This is the "second brain":
   * two people researching the same market end up with different decks because
   * their threads differ.
   */
  threads: ResearchThread[];
}

export interface ResearchStore {
  read(): RepoSnapshot | null;
  write(snapshot: RepoSnapshot): void;
}

const empty = (): RepoSnapshot => ({
  markets: [],
  decks: [],
  companies: [],
  metrics: [],
  cards: [],
  viceClaims: [],
  dashboards: {},
  companyMarket: {},
  reports: [],
  savedCards: [],
  opportunity: {},
  researchJobs: [],
  threads: [],
});

function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(incorporated|corporation|company|limited|holdings|group|inc|llc|ltd|corp|plc|ag)\b/g,
      '',
    )
    .replace(/[^a-z0-9]/g, '');
}

function stageForStep(step: string): ResearchStage {
  if (step === 'interpret') return 'scope';
  if (step === 'discover') return 'catalog';
  if (step === 'enrich') return 'summary';
  if (step === 'score') return 'metrics';
  if (step === 'barriers') return 'signals';
  return 'dashboard';
}

/** Migration-safe read: older persisted snapshots may lack newer fields. */
function normalize(raw: RepoSnapshot | null): RepoSnapshot {
  if (!raw) return empty();
  const researchJobs = (raw.researchJobs ?? []).map((job) => ({
    ...job,
    // A job persisted as running can never resume if the process died with no
    // live AbortController. Reap it into a resumable failed state.
    status: job.status === 'running' ? ('failed' as const) : job.status,
    error: job.status === 'running' ? (job.error ?? 'Interrupted by restart.') : job.error,
    partialCards: job.partialCards ?? [],
  }));
  return {
    ...empty(),
    ...raw,
    reports: raw.reports ?? [],
    savedCards: raw.savedCards ?? [],
    opportunity: raw.opportunity ?? {},
    researchJobs,
    threads: raw.threads ?? [],
  };
}

/**
 * Optional prose-elevation pass (BYOK power-up). Receives a finished,
 * Gemini-grounded draft and returns an elevated rewrite. It must never add
 * facts — grounding, figures, and citations always come from the free path.
 * Any throw is swallowed by the caller (fail-open to the draft).
 */
export type ProseElevator = (args: {
  markdown: string;
  kind: 'report' | 'deep_dive';
  title?: string;
}) => Promise<string>;

export interface GeminiRepositoryOptions extends GeminiClientConfig {
  store?: ResearchStore;
  /** Inject a client for tests (bypasses network). */
  client?: LlmClient;
  targetCompanies?: number;
  concurrency?: number;
  /** Optional BYOK writer pass for reports/deep-dives (fail-open). */
  elevator?: ProseElevator;
  /** Explicit deck coverage policy; omitted uses the production minimums. */
  coverage?: Partial<ResearchCoverage>;
  catalogMax?: number;
  catalogPasses?: number;
}

export class GeminiRepository implements MarketIntelRepository {
  private snap: RepoSnapshot;
  private readonly client: LlmClient;
  private readonly store?: ResearchStore;
  private readonly targetCompanies?: number;
  private readonly concurrency?: number;
  private readonly elevator?: ProseElevator;
  private readonly coverage?: Partial<ResearchCoverage>;
  private readonly catalogMax?: number;
  private readonly catalogPasses?: number;
  private readonly jobControllers = new Map<string, AbortController>();
  private listeners = new Set<DeckRefreshListener>();

  constructor(options: GeminiRepositoryOptions) {
    this.client = options.client ?? createGeminiClient(options);
    this.store = options.store;
    this.targetCompanies = options.targetCompanies;
    this.concurrency = options.concurrency;
    this.elevator = options.elevator;
    this.coverage = options.coverage;
    this.catalogMax = options.catalogMax;
    this.catalogPasses = options.catalogPasses;
    this.snap = normalize(this.store?.read() ?? null);
  }

  /** Apply the optional BYOK writer pass; on ANY failure return the draft untouched. */
  private async elevate(
    markdown: string,
    kind: 'report' | 'deep_dive',
    title?: string,
  ): Promise<string> {
    if (!this.elevator) return markdown;
    try {
      const out = await this.elevator({ markdown, kind, title });
      // Sanity: an elevation that loses most of the draft is a failure, not a rewrite.
      return out && out.length > markdown.length * 0.4 ? out : markdown;
    } catch {
      return markdown;
    }
  }

  private persist(): void {
    this.store?.write(this.snap);
  }

  /** Flatten a pipeline result into the normalized store. */
  private ingest(result: ResearchResult): void {
    this.snap.markets = [
      result.market,
      ...this.snap.markets.filter((m) => m.id !== result.market.id),
    ];
    this.snap.decks = [result.deck, ...this.snap.decks.filter((d) => d.id !== result.deck.id)];
    const existingCompanyIds = new Set(this.snap.companies.map((company) => company.id));
    const companyById = new Map<string, Company>();
    const metrics: CompanyMetric[] = [];
    for (const cwc of result.cards) {
      this.snap.cards.push(cwc.card);
      if (cwc.company && !companyById.has(cwc.company.id)) {
        companyById.set(cwc.company.id, cwc.company);
        metrics.push(...cwc.metrics);
        this.snap.companyMarket[cwc.company.id] = result.market.name;
      }
      this.snap.viceClaims.push(...cwc.viceClaims);
    }
    for (const company of companyById.values()) {
      const index = this.snap.companies.findIndex((existing) => existing.id === company.id);
      if (index >= 0) this.snap.companies[index] = company;
      else this.snap.companies.push(company);
    }
    this.snap.metrics = reconcileMetrics(this.snap.metrics, metrics);
    const deckUserValues = this.snap.metrics
      .filter(
        (metric) =>
          metric.metricType === 'users' && metric.confidence !== 'unknown' && metric.value !== null,
      )
      .map((metric) => metric.value as number);
    for (const companyId of companyById.keys()) {
      if (!existingCompanyIds.has(companyId)) continue;
      const canonicalMetrics = this.snap.metrics.filter((metric) => metric.companyId === companyId);
      const canonicalTier = computeCms(buildCmsInput(canonicalMetrics), {
        deckUserValues,
      }).finalTier;
      for (const card of this.snap.cards) {
        if (
          card.companyId === companyId &&
          card.cardType === 'company' &&
          card.tier !== canonicalTier
        ) {
          card.tier = canonicalTier;
          card.tierReason = 'Re-tiered after canonical metric reconciliation.';
        }
      }
    }
    // Dashboard tabs are cached projections. Invalidate every affected company
    // so a newly detected contradiction cannot leave one tab on stale evidence
    // while the card and Metrics tab show a different canonical value.
    for (const companyId of companyById.keys()) this.snap.dashboards[companyId] = {};
    this.persist();
  }

  // Markets -----------------------------------------------------------------
  listMarkets(): Promise<Market[]> {
    return Promise.resolve([...this.snap.markets]);
  }
  getMarket(id: string): Promise<Market | null> {
    return Promise.resolve(this.snap.markets.find((m) => m.id === id) ?? null);
  }
  createMarket(input: CreateMarketInput): Promise<Market> {
    const market: Market = {
      id: `mkt_${Date.now().toString(36)}`,
      name: input.name,
      scopeDefinition: input.scopeDefinition,
      refreshCadence: input.refreshCadence,
      createdAt: new Date().toISOString(),
    };
    this.snap.markets = [market, ...this.snap.markets];
    this.snap.decks = [
      ...this.snap.decks,
      {
        id: `dck_${Date.now().toString(36)}`,
        marketId: market.id,
        createdAt: market.createdAt,
        lastRefreshedAt: null,
      },
    ];
    this.persist();
    return Promise.resolve(market);
  }
  updateMarketCadence(id: string, cadence: RefreshCadence): Promise<Market> {
    const market = this.snap.markets.find((m) => m.id === id);
    if (!market) return Promise.reject(new Error(`Market not found: ${id}`));
    market.refreshCadence = cadence;
    this.persist();
    return Promise.resolve(market);
  }

  // Decks -------------------------------------------------------------------
  getDeckByMarket(marketId: string): Promise<Deck | null> {
    return Promise.resolve(this.snap.decks.find((d) => d.marketId === marketId) ?? null);
  }

  listResearchJobs(): Promise<ResearchJob[]> {
    return Promise.resolve(
      [...this.snap.researchJobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  getResearchJob(id: string): Promise<ResearchJob | null> {
    return Promise.resolve(this.snap.researchJobs.find((job) => job.id === id) ?? null);
  }

  async cancelResearchJob(id: string): Promise<ResearchJob | null> {
    const job = this.snap.researchJobs.find((candidate) => candidate.id === id);
    if (!job) return null;
    this.jobControllers.get(id)?.abort();
    job.status = 'cancelled';
    job.error = 'Cancelled by user.';
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  async resumeResearchJob(id: string): Promise<ResearchJob | null> {
    const job = this.snap.researchJobs.find((candidate) => candidate.id === id);
    if (!job) return null;
    if (job.status === 'running' || job.status === 'completed') return job;
    if (!job.marketPlan || !job.market || !job.deck || !job.catalog) return job;
    const controller = new AbortController();
    this.jobControllers.set(id, controller);
    job.status = 'running';
    job.error = null;
    job.updatedAt = new Date().toISOString();
    this.persist();
    try {
      const result = await runDeckResearch(job.brief, this.client, {
        apiKey: '',
        signal: controller.signal,
        concurrency: this.concurrency,
        coverage: this.coverage,
        catalogMax: this.catalogMax,
        catalogPasses: this.catalogPasses,
        resume: {
          plan: job.marketPlan,
          market: job.market,
          deck: job.deck,
          candidates: job.catalog,
          completedCards: job.partialCards,
        },
      });
      job.status = 'completed';
      job.stage = 'signals';
      job.partialCards = result.cards;
      job.market = result.market;
      job.deck = result.deck;
      job.completedEntityNames = result.cards
        .filter((card) => card.company)
        .map((card) => card.company!.name)
        .filter((name, index, names) => names.indexOf(name) === index);
      job.updatedAt = new Date().toISOString();
      this.persist();
      this.jobControllers.delete(id);
      this.ingest(result);
      return job;
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : 'Resume failed.';
      job.updatedAt = new Date().toISOString();
      this.persist();
      this.jobControllers.delete(id);
      return job;
    }
  }

  async createResearchedDeck(
    brief: DeckResearchBrief,
    handlers?: ResearchHandlers,
  ): Promise<{ market: Market; deck: Deck }> {
    const now = new Date().toISOString();
    const job: ResearchJob = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      status: 'running',
      stage: 'scope',
      brief,
      catalogNames: [],
      completedEntityNames: [],
      partialCards: [],
      warnings: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();
    this.jobControllers.set(job.id, controller);
    if (handlers?.signal) {
      if (handlers.signal.aborted) controller.abort();
      else handlers.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.snap.researchJobs = [...this.snap.researchJobs.slice(-49), job];
    this.persist();
    const checkpoint = (evt: Parameters<NonNullable<RunResearchOptions['onEvent']>>[0]): void => {
      job.updatedAt = new Date().toISOString();
      if (evt.type === 'status') job.stage = stageForStep(evt.step);
      if (evt.type === 'market') job.marketPlan = evt.market;
      if (evt.type === 'candidates') {
        job.catalogNames = evt.candidates.map((candidate) => candidate.name);
        job.catalog = evt.candidates;
      }
      if (evt.type === 'warning') job.warnings.push(evt.message);
      if (evt.type === 'card') {
        const existingCardIndex = job.partialCards.findIndex(
          (card) => card.card.id === evt.card.card.id,
        );
        if (existingCardIndex >= 0) job.partialCards[existingCardIndex] = evt.card;
        else job.partialCards.push(evt.card);
        if (
          evt.card.company &&
          ['company', 'infrastructure', 'distribution'].includes(evt.card.card.cardType) &&
          !job.completedEntityNames.includes(evt.card.company.name)
        ) {
          job.completedEntityNames.push(evt.card.company.name);
        }
      }
      this.persist();
    };
    let result: ResearchResult;
    try {
      result = await runDeckResearch(brief, this.client, {
        apiKey: '', // client already constructed
        onEvent: (evt) => {
          checkpoint(evt);
          // Glass-box stream: forward the pipeline's real steps as typed log lines.
          const p = handlers?.onProgress;
          if (!p) return;
          if (evt.type === 'status')
            p({
              message: evt.message,
              stage: stageForStep(evt.step),
              progress: evt.progress,
              kind: 'step',
            });
          else if (evt.type === 'market')
            p({
              message: `Market defined: ${evt.market.marketName} · angles: ${evt.market.searchThemes.slice(0, 4).join(' / ')}`,
              stage: 'scope',
              kind: 'find',
            });
          else if (evt.type === 'candidates')
            p({
              message: `Discovered ${evt.candidates.length} entities: ${evt.candidates
                .map((c) => c.name)
                .slice(0, 8)
                .join(', ')}${evt.candidates.length > 8 ? '…' : ''}`,
              stage: 'catalog',
              kind: 'find',
            });
          else if (evt.type === 'card') {
            const c = evt.card;
            const label = c.company?.name ?? c.card.title ?? 'card';
            p({
              message: `+ ${c.card.cardType} card: ${label}${c.card.tier ? ` (T${c.card.tier})` : ''} · ${c.metrics.filter((m) => m.value != null).length} metrics`,
              stage:
                c.card.cardType === 'company' ||
                c.card.cardType === 'infrastructure' ||
                c.card.cardType === 'distribution'
                  ? 'summary'
                  : 'signals',
              card: c,
              kind: 'find',
            });
          } else if (evt.type === 'warning') p({ message: evt.message, kind: 'warn' });
        },
        signal: controller.signal,
        targetCompanies: this.targetCompanies,
        concurrency: this.concurrency,
        coverage: this.coverage,
        catalogMax: this.catalogMax,
        catalogPasses: this.catalogPasses,
      });
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : 'Research failed.';
      job.updatedAt = new Date().toISOString();
      this.persist();
      this.jobControllers.delete(job.id);
      throw error;
    }
    if (job.status === 'cancelled' || controller.signal.aborted) {
      job.status = 'cancelled';
      job.error = 'Cancelled by user.';
      job.updatedAt = new Date().toISOString();
      this.persist();
      this.jobControllers.delete(job.id);
      throw new Error('Research cancelled');
    }
    job.status = 'completed';
    job.stage = 'signals';
    job.market = result.market;
    job.deck = result.deck;
    job.updatedAt = new Date().toISOString();
    this.persist();
    this.jobControllers.delete(job.id);
    this.ingest(result);
    return { market: result.market, deck: result.deck };
  }

  async refreshDeck(marketId: string): Promise<Deck> {
    const market = this.snap.markets.find((m) => m.id === marketId);
    const deck = this.snap.decks.find((d) => d.marketId === marketId);
    if (!market || !deck) return Promise.reject(new Error(`Market/deck not found: ${marketId}`));
    // Re-run research for the same scope, replacing this deck's cards.
    const brief: DeckResearchBrief = {
      prompt: `${market.scopeDefinition.vertical}${market.name ? ` — ${market.name}` : ''}`,
      region: market.scopeDefinition.geography,
    };
    const before = this.snap.cards.filter((c) => c.deckId === deck.id).map((c) => c.id);
    const result = await runDeckResearch(brief, this.client, {
      apiKey: '',
      coverage: this.coverage,
      catalogMax: this.catalogMax,
      catalogPasses: this.catalogPasses,
      concurrency: this.concurrency,
    });
    // Re-point the fresh cards at stable company identities before replacing the
    // deck. A refresh must not create duplicate companies for the same business.
    const previousDeckCards = this.snap.cards.filter((card) => card.deckId === deck.id);
    const previousCompanyIds = new Set(
      previousDeckCards.map((card) => card.companyId).filter(Boolean),
    );
    const previousCompanies = this.snap.companies.filter((company) =>
      previousCompanyIds.has(company.id),
    );
    const existingByName = new Map(
      previousCompanies.map((company) => [companyKey(company.name), company.id]),
    );
    const replacementCompanyIds = new Set<string>();
    for (const cwc of result.cards) {
      cwc.card.deckId = deck.id;
      if (!cwc.company) continue;
      const stableId = existingByName.get(companyKey(cwc.company.name));
      if (stableId) {
        cwc.company.id = stableId;
        cwc.card.companyId = stableId;
        cwc.metrics.forEach((metric) => (metric.companyId = stableId));
        replacementCompanyIds.add(stableId);
      } else replacementCompanyIds.add(cwc.company.id);
    }
    this.snap.cards = this.snap.cards.filter((card) => card.deckId !== deck.id);
    this.snap.metrics = this.snap.metrics.filter(
      (metric) =>
        !previousCompanyIds.has(metric.companyId) || replacementCompanyIds.has(metric.companyId),
    );
    this.snap.companies = this.snap.companies.filter(
      (company) => !previousCompanyIds.has(company.id) || replacementCompanyIds.has(company.id),
    );
    this.ingest({
      market,
      deck: { ...deck, lastRefreshedAt: new Date().toISOString() },
      cards: result.cards,
    });
    const after = this.snap.cards.filter((c) => c.deckId === deck.id).map((c) => c.id);
    const updated = this.snap.decks.find((d) => d.id === deck.id)!;
    this.emit({
      marketId,
      deckId: deck.id,
      refreshedAt: updated.lastRefreshedAt ?? new Date().toISOString(),
      addedCardIds: after.filter((id) => !before.includes(id)),
      updatedCardIds: [],
      prunedCardIds: before,
    });
    return updated;
  }

  // Cards -------------------------------------------------------------------
  listCards(deckId: string, filter?: CardFilter): Promise<CardWithCompany[]> {
    const result = this.snap.cards
      .filter((c) => c.deckId === deckId)
      .filter((c) => (filter?.cardType ? c.cardType === filter.cardType : true))
      .filter((c) => (filter?.tier ? c.tier === filter.tier : true))
      .map((card) => this.hydrate(card));
    return Promise.resolve(result);
  }
  getCard(cardId: string): Promise<CardWithCompany | null> {
    const card = this.snap.cards.find((c) => c.id === cardId);
    return Promise.resolve(card ? this.hydrate(card) : null);
  }

  listSavedCards(): Promise<CardWithCompany[]> {
    const savedIds = new Set(this.snap.savedCards.map((saved) => saved.cardId));
    return Promise.resolve(
      this.snap.cards.filter((card) => savedIds.has(card.id)).map((card) => this.hydrate(card)),
    );
  }

  saveCard(cardId: string): Promise<SavedCard> {
    if (!this.snap.cards.some((card) => card.id === cardId)) {
      return Promise.reject(new Error(`Card not found: ${cardId}`));
    }
    const existing = this.snap.savedCards.find((saved) => saved.cardId === cardId);
    if (existing) return Promise.resolve(existing);
    const saved = { cardId, savedAt: new Date().toISOString() };
    this.snap.savedCards.push(saved);
    this.persist();
    return Promise.resolve(saved);
  }

  unsaveCard(cardId: string): Promise<void> {
    this.snap.savedCards = this.snap.savedCards.filter((saved) => saved.cardId !== cardId);
    this.persist();
    return Promise.resolve();
  }

  private hydrate(card: Card): CardWithCompany {
    const company = card.companyId
      ? (this.snap.companies.find((c) => c.id === card.companyId) ?? null)
      : null;
    const metrics = card.companyId
      ? this.snap.metrics.filter((m) => m.companyId === card.companyId)
      : [];
    const viceClaims =
      card.cardType === 'vice' ? this.snap.viceClaims.filter((v) => v.cardId === card.id) : [];
    return { card, company, metrics, viceClaims };
  }

  getCompany(companyId: string): Promise<Company | null> {
    return Promise.resolve(this.snap.companies.find((c) => c.id === companyId) ?? null);
  }
  getCompanyMetrics(companyId: string): Promise<CompanyMetric[]> {
    return Promise.resolve(this.snap.metrics.filter((m) => m.companyId === companyId));
  }
  getViceClaims(cardId: string): Promise<ViceClaim[]> {
    return Promise.resolve(this.snap.viceClaims.filter((v) => v.cardId === cardId));
  }

  // Dashboard (lazy, cached) -----------------------------------------------
  async getDashboardTab<T extends DashboardTab>(
    companyId: string,
    tab: T,
    force?: boolean,
  ): Promise<DashboardTabResult<T> | null> {
    const company = this.snap.companies.find((c) => c.id === companyId);
    if (!company) return null;
    const cached = force ? undefined : this.snap.dashboards[companyId]?.[tab];
    if (cached) {
      return {
        companyId,
        tab,
        content: cached.content as DashboardTabResult<T>['content'],
        lastRefreshedAt: cached.lastRefreshedAt,
      };
    }
    const content = await researchDashboardTab(tab, {
      company,
      marketName: this.snap.companyMarket[companyId] ?? 'this market',
      storedMetrics: this.snap.metrics.filter((m) => m.companyId === companyId),
      client: this.client,
    });
    const lastRefreshedAt = new Date().toISOString();
    this.snap.dashboards[companyId] = {
      ...this.snap.dashboards[companyId],
      [tab]: { content, lastRefreshedAt },
    };
    this.persist();
    return { companyId, tab, content, lastRefreshedAt };
  }

  async deepDive(input: DeepDiveInput): Promise<DeepDiveResult> {
    const prompt = [
      `Research "${input.topic}" for the company ${input.companyName}${input.context ? ` (${input.context})` : ''} in depth, using Google Search.`,
      `Write a clear, well-structured markdown explanation: a one-line summary, then 2-4 short sections or bullet lists covering concrete figures, dates, drivers, and context. Cite specifics from the search results.`,
      `If a detail is not disclosed or you cannot verify it, say so explicitly — do NOT speculate or invent numbers.`,
    ].join('\n');
    const g = await this.client.ground(prompt, { system: GROUNDED_SYSTEM });
    const markdown = await this.elevate(g.text, 'deep_dive', input.topic);
    return { markdown, citations: g.citations };
  }

  async factCheck(input: FactCheckInput): Promise<FactCheckResult> {
    const g = await this.client.ground(
      [
        `Fact-check this claim${input.companyName ? ` about ${input.companyName}` : ''} using Google Search:`,
        `"${input.claim}"`,
        input.context ? `Context: ${input.context}` : '',
        `State clearly whether the search results SUPPORT the claim, CONTRADICT it, or cannot verify it, and summarize the strongest evidence either way with specifics (figures, dates, sources). Never guess.`,
      ]
        .filter(Boolean)
        .join('\n'),
      { system: GROUNDED_SYSTEM },
    );
    const out = await this.client.structure(
      `Based ONLY on these fact-check notes, output JSON { "verdict": "supported"|"contradicted"|"unverified", "rationale": string (1-3 sentences) }.\n\nNOTES:\n${g.text}`,
      factCheckOutSchema,
      { system: STRUCTURE_SYSTEM },
    );
    return {
      verdict: out.verdict ?? 'unverified',
      rationale: out.rationale ?? '',
      citations: g.citations,
    };
  }

  async generateReport(request: ReportRequest): Promise<Report> {
    let title = 'Research Report';
    let digest = '';
    if (request.kind === 'deck') {
      const deck = this.snap.decks.find((d) => d.id === request.subjectId);
      const market = deck ? this.snap.markets.find((m) => m.id === deck.marketId) : null;
      if (!deck || !market) throw new Error('Deck not found for report');
      title = `${market.name} — Market Report`;
      const cards = this.snap.cards.filter((c) => c.deckId === deck.id);
      const lines: string[] = [`MARKET: ${market.name} (${market.scopeDefinition.vertical})`];
      for (const card of cards) {
        const co = card.companyId ? this.snap.companies.find((c) => c.id === card.companyId) : null;
        if (card.cardType === 'company' && co) {
          const ms = this.snap.metrics.filter((m) => m.companyId === co.id);
          const fmt = ms
            .filter((m) => m.value != null)
            .map((m) => `${m.metricType}=${m.value} (${m.confidence})`)
            .join(', ');
          lines.push(`COMPANY [tier ${card.tier ?? '?'}] ${co.name}: ${co.oneLiner}. ${fmt}`);
        } else if (card.cardType === 'barrier') {
          lines.push(`BARRIER: ${card.title} — ${card.summary}`);
        } else if (co) {
          lines.push(`${card.cardType.toUpperCase()}: ${co.name} — ${co.oneLiner}`);
        }
      }
      digest = lines.join('\n');
    } else {
      const company = this.snap.companies.find((c) => c.id === request.subjectId);
      if (!company) throw new Error('Company not found for report');
      title = `${company.name} — Company Report`;
      const ms = this.snap.metrics.filter((m) => m.companyId === company.id);
      digest = [
        `COMPANY: ${company.name} (${this.snap.companyMarket[company.id] ?? 'market unknown'})`,
        `${company.oneLiner} HQ: ${company.hqLocation ?? '?'} Site: ${company.websiteUrl ?? '?'}`,
        ...ms.map(
          (m) =>
            `${m.metricType}=${m.value ?? 'unknown'} (${m.confidence}${m.methodNote ? `, method: ${m.methodNote}` : ''})`,
        ),
      ].join('\n');
    }

    const focus = (request.focus ?? '').trim();
    const thread = request.threadId
      ? this.snap.threads.find((t) => t.id === request.threadId)
      : null;
    const conversation = thread
      ? thread.messages
          .map((m) => `${m.role === 'user' ? 'ANALYST ASKED' : 'RESEARCH FOUND'}: ${m.text}`)
          .join('\n')
          .slice(0, 6000)
      : '';

    const g = await this.client.ground(
      [
        `Write an executive-ready research report in GitHub-flavored markdown titled "${title}".`,
        `Base it on the EVIDENCE DIGEST below (already-researched, sourced data) plus a fresh Google Search pass for current context and outlook.`,
        focus
          ? `REPORT FOCUS — the analyst wants the report concentrated on: "${focus}". Steer structure and emphasis toward this; the evidence rules do not change.`
          : '',
        conversation
          ? `CONVERSATION FINDINGS — the analyst already dug into this in a grounded research session. Weave the substance of these findings in (re-verify anything surprising):\n${conversation}`
          : '',
        `Structure: ## Executive summary · ## Landscape · ## Key players & signals · ## Risks & barriers · ## Outlook & what to watch. Keep claims attributed; where the digest marks a figure estimated/unknown, say so — never upgrade confidence or invent numbers.`,
        `Style: prose plus standard markdown lists/tables ONLY — never ASCII-art diagrams or box drawings. Do not repeat the report title as a heading; start directly with "## Executive summary".`,
        ``,
        `EVIDENCE DIGEST:`,
        digest,
      ]
        .filter(Boolean)
        .join('\n'),
      { system: GROUNDED_SYSTEM },
    );

    const markdown = await this.elevate(g.text, 'report', title);
    const evidenceCitations = usableCitations(
      this.snap.metrics.flatMap((metric) => metric.citations).concat(g.citations),
    );
    const report: Report = {
      id: `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: request.kind,
      subjectId: request.subjectId,
      title,
      markdown,
      citations: g.citations,
      evidenceDigest: digest,
      evidenceCitations,
      createdAt: new Date().toISOString(),
    };
    this.snap.reports = [report, ...this.snap.reports];
    this.persist();
    return report;
  }

  listReports(): Promise<Report[]> {
    return Promise.resolve([...this.snap.reports]);
  }
  getReport(id: string): Promise<Report | null> {
    return Promise.resolve(this.snap.reports.find((r) => r.id === id) ?? null);
  }

  // Research conversations ---------------------------------------------------

  /**
   * Serialize everything the deck already KNOWS about a scope, compactly, with
   * confidence tags and publishers intact. This is half of the grounding
   * contract for chat: prior grounded research + a fresh search — never
   * training data.
   */
  private scopeDigest(scope: ResearchScope): string {
    const lines: string[] = [];
    const push = (l: string) => lines.push(l);

    const companyLines = (co: Company) => {
      const tierCard = this.snap.cards.find((c) => c.companyId === co.id && c.tier != null);
      const ms = this.snap.metrics.filter((m) => m.companyId === co.id);
      const fmt = ms
        .map(
          (m) =>
            `${m.metricType}=${m.value ?? 'unknown'} (${m.confidence}${m.citations?.[0]?.title ? ` per ${m.citations[0].title}` : ''})`,
        )
        .join(', ');
      push(
        `COMPANY${tierCard?.tier ? ` [T${tierCard.tier}]` : ''} ${co.name} — ${co.oneLiner} ${fmt}`,
      );
      for (const vc of this.snap.viceClaims.filter((v) =>
        this.snap.cards.some((c) => c.id === v.cardId && c.companyId === co.id),
      )) {
        push(`  RISK SIGNAL (sourced): ${vc.claimText}`);
      }
    };

    const marketCardLine = (card: Card) => {
      push(`${card.cardType.toUpperCase()}: ${card.title} — ${card.summary ?? ''}`);
      for (const k of card.keyPoints ?? []) push(`  · ${k}`);
    };

    const deck = scope.deckId ? this.snap.decks.find((d) => d.id === scope.deckId) : null;
    const market = deck ? this.snap.markets.find((m) => m.id === deck.marketId) : null;
    if (market) push(`MARKET: ${market.name} (${market.scopeDefinition.vertical})`);

    if (scope.kind === 'cards' && scope.cardIds?.length) {
      for (const id of scope.cardIds) {
        const card = this.snap.cards.find((c) => c.id === id);
        if (!card) continue;
        const co = card.companyId ? this.snap.companies.find((c) => c.id === card.companyId) : null;
        if (co) companyLines(co);
        else marketCardLine(card);
      }
    } else if (scope.companyId) {
      const co = this.snap.companies.find((c) => c.id === scope.companyId);
      if (co) companyLines(co);
    } else if (deck) {
      for (const card of this.snap.cards.filter((c) => c.deckId === deck.id && !c.companyId)) {
        marketCardLine(card);
      }
      const companyIds = new Set(
        this.snap.cards
          .filter((c) => c.deckId === deck.id && c.companyId)
          .map((c) => c.companyId as string),
      );
      for (const id of companyIds) {
        const co = this.snap.companies.find((c) => c.id === id);
        if (co) companyLines(co);
      }
    }
    // A digest is context, not a payload — cap it well under the model's window.
    return lines.join('\n').slice(0, 9000);
  }

  async askResearch(input: AskResearchInput): Promise<ResearchThread> {
    const now = new Date().toISOString();
    const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    let thread = input.threadId
      ? this.snap.threads.find((t) => t.id === input.threadId)
      : undefined;
    if (!thread) {
      if (!input.scope) throw new Error('A new research thread needs a scope.');
      thread = {
        id: `thr_${rid()}`,
        scope: input.scope,
        title: input.question.length > 76 ? `${input.question.slice(0, 76)}…` : input.question,
        messages: [],
        reportId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.snap.threads = [thread, ...this.snap.threads];
    }

    thread.messages.push({
      id: `msg_${rid()}`,
      role: 'user',
      text: input.question,
      citations: [],
      at: now,
    });
    this.persist();

    // Short conversational memory: the last few turns, so follow-ups read
    // naturally. The full record stays on the thread either way.
    const history = thread.messages
      .slice(-7, -1)
      .map((m) => `${m.role === 'user' ? 'ANALYST' : 'RESEARCHER'}: ${m.text.slice(0, 700)}`)
      .join('\n');

    const g = await this.client.ground(
      [
        `DECK DATA (this deck's prior grounded research — confidence tags and publishers are part of the record):`,
        this.scopeDigest(thread.scope),
        thread.scope.subject ? `\nTHE ANALYST IS FOCUSED ON: ${thread.scope.subject}` : '',
        history ? `\nCONVERSATION SO FAR:\n${history}` : '',
        ``,
        `ANALYST'S QUESTION: ${input.question}`,
      ]
        .filter(Boolean)
        .join('\n'),
      { system: CHAT_SYSTEM },
    );

    thread.messages.push({
      id: `msg_${rid()}`,
      role: 'assistant',
      text: g.text,
      citations: g.citations,
      at: new Date().toISOString(),
    });
    thread.updatedAt = new Date().toISOString();
    this.persist();
    return { ...thread, messages: [...thread.messages] };
  }

  listResearchThreads(filter?: { deckId?: string; companyId?: string }): Promise<ResearchThread[]> {
    const out = this.snap.threads
      .filter((t) => (filter?.deckId ? t.scope.deckId === filter.deckId : true))
      .filter((t) => (filter?.companyId ? t.scope.companyId === filter.companyId : true))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return Promise.resolve(out.map((t) => ({ ...t, messages: [...t.messages] })));
  }

  getResearchThread(id: string): Promise<ResearchThread | null> {
    const t = this.snap.threads.find((x) => x.id === id);
    return Promise.resolve(t ? { ...t, messages: [...t.messages] } : null);
  }

  async saveThreadAsReport(threadId: string, focus?: string | null): Promise<Report> {
    const thread = this.snap.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('Research thread not found.');
    const request: ReportRequest = thread.scope.companyId
      ? {
          kind: 'company',
          subjectId: thread.scope.companyId,
          focus: focus ?? thread.title,
          threadId,
        }
      : {
          kind: 'deck',
          subjectId: thread.scope.deckId ?? '',
          focus: focus ?? thread.title,
          threadId,
        };
    const report = await this.generateReport(request);
    thread.reportId = report.id;
    thread.updatedAt = new Date().toISOString();
    this.persist();
    return report;
  }

  async expandDeck(
    marketId: string,
    focus: ExpandFocus,
    handlers?: ResearchHandlers,
  ): Promise<{ added: number }> {
    const market = this.snap.markets.find((m) => m.id === marketId);
    const deck = this.snap.decks.find((d) => d.marketId === marketId);
    if (!market || !deck) throw new Error(`Market/deck not found: ${marketId}`);
    const focusPrompt = focus.tier
      ? `${TIER_LABELS[focus.tier]}-stage companies (${TIER_BLURBS[focus.tier]})`
      : focus.cardType
        ? CARD_TYPE_DESCRIPTIONS[focus.cardType]
        : 'notable companies missed in the first pass';
    const existing = this.snap.cards
      .filter((c) => c.deckId === deck.id && c.companyId)
      .map((c) => this.snap.companies.find((x) => x.id === c.companyId)?.name ?? '')
      .filter(Boolean);
    const deckUserValues = this.snap.metrics
      .filter((m) => m.metricType === 'users' && m.confidence !== 'unknown' && m.value !== null)
      .map((m) => m.value as number);

    const cards = await expandDeckResearch({
      client: this.client,
      marketName: market.name,
      vertical: market.scopeDefinition.vertical,
      geography: market.scopeDefinition.geography,
      focusPrompt,
      excludeNames: existing,
      deckId: deck.id,
      deckUserValues,
      target: 3,
      signal: handlers?.signal,
      onEvent: (evt) => {
        if (evt.type === 'status') handlers?.onProgress?.({ message: evt.message, kind: 'step' });
      },
    });

    // For card-type focus, retag the found companies to that type.
    for (const cwc of cards) {
      if (focus.cardType && focus.cardType !== 'company') {
        cwc.card.cardType = focus.cardType;
        cwc.card.tier = null;
        cwc.card.tierReason = null;
      }
      if (cwc.company && !this.snap.companies.some((c) => c.id === cwc.company!.id)) {
        this.snap.companies.push(cwc.company);
        this.snap.metrics.push(...cwc.metrics);
        this.snap.companyMarket[cwc.company.id] = market.name;
      }
      this.snap.cards.push(cwc.card);
    }
    this.persist();
    if (cards.length > 0) {
      this.emit({
        marketId,
        deckId: deck.id,
        refreshedAt: new Date().toISOString(),
        addedCardIds: cards.map((c) => c.card.id),
        updatedCardIds: [],
        prunedCardIds: [],
      });
    }
    return { added: cards.length };
  }

  overrideMetric(input: OverrideMetricInput): Promise<CompanyMetric> {
    const company = this.snap.companies.find((c) => c.id === input.companyId);
    if (!company) return Promise.reject(new Error(`Company not found: ${input.companyId}`));
    let metric = this.snap.metrics.find(
      (m) => m.companyId === input.companyId && m.metricType === input.metricType,
    );
    if (!metric) {
      metric = {
        id: `met_override_${Date.now().toString(36)}`,
        companyId: input.companyId,
        metricType: input.metricType,
        value: null,
        confidence: 'unknown',
        source: null,
        citations: [],
        methodNote: null,
        capturedAt: new Date().toISOString(),
      };
      this.snap.metrics.push(metric);
    }
    metric.value = input.value;
    metric.confidence = input.value == null ? 'unknown' : 'user_verified';
    // A human override is its own provenance: the note IS the source.
    metric.source = input.note?.trim() || 'Manually corrected by user';
    metric.citations = [];
    metric.methodNote = input.note ?? 'Manually corrected by user';
    metric.capturedAt = new Date().toISOString();
    this.snap.dashboards[input.companyId] = {};
    this.snap.opportunity = Object.fromEntries(
      Object.entries(this.snap.opportunity).filter(([marketId]) => {
        const companyMarket = this.snap.companyMarket[input.companyId];
        const market = this.snap.markets.find((candidate) => candidate.name === companyMarket);
        return market?.id !== marketId;
      }),
    );

    // Recompute the CMS tier for this company's company-cards (auditable: base
    // tier from rules; prior LLM nudge is dropped as stale after an override).
    const companyCards = this.snap.cards.filter(
      (c) => c.companyId === input.companyId && c.cardType === 'company',
    );
    const updatedIds: string[] = [];
    for (const card of companyCards) {
      const deckUserValues = this.snap.metrics
        .filter((m) => m.metricType === 'users' && m.confidence !== 'unknown' && m.value !== null)
        .map((m) => m.value as number);
      const metrics = this.snap.metrics.filter((m) => m.companyId === input.companyId);
      const result = computeCms(buildCmsInput(metrics), { deckUserValues });
      if (result.finalTier !== card.tier) {
        card.tier = result.finalTier;
        card.tierReason = 'Re-tiered after a user-verified metric override.';
        updatedIds.push(card.id);
      }
    }
    this.persist();
    if (updatedIds.length > 0) {
      const deck = this.snap.decks.find((d) => companyCards.some((c) => c.deckId === d.id));
      if (deck) {
        this.emit({
          marketId: deck.marketId,
          deckId: deck.id,
          refreshedAt: new Date().toISOString(),
          addedCardIds: [],
          updatedCardIds: updatedIds,
          prunedCardIds: [],
        });
      }
    }
    return Promise.resolve(metric);
  }

  async getMarketOpportunity(marketId: string, force = false): Promise<DeepDiveResult> {
    const cached = this.snap.opportunity[marketId];
    if (cached && !force) return { markdown: cached.markdown, citations: cached.citations };
    const market = this.snap.markets.find((m) => m.id === marketId);
    const deck = this.snap.decks.find((d) => d.marketId === marketId);
    if (!market || !deck) throw new Error(`Market/deck not found: ${marketId}`);
    const lines = this.snap.cards
      .filter((c) => c.deckId === deck.id && c.cardType === 'company' && c.companyId)
      .map((c) => {
        const co = this.snap.companies.find((x) => x.id === c.companyId)!;
        const ms = this.snap.metrics.filter((m) => m.companyId === co.id && m.value != null);
        return `[T${c.tier ?? '?'}] ${co.name}: ${co.oneLiner} | ${ms.map((m) => `${m.metricType}=${m.value}`).join(', ')}`;
      });
    const g = await this.client.ground(
      [
        `You are analyzing the market "${market.name}" (${market.scopeDefinition.vertical}). Known landscape:`,
        ...lines,
        ``,
        `Using Google Search for current context, produce a whitespace analysis in markdown:`,
        `## Positioning axes — name the two most differentiating axes you observe for a 2×2 of this market and say where each company sits (one line each).`,
        `## The whitespace — a 3-bullet thesis on the underserved quadrant/gap and why it is open.`,
        `## Closest to the gap — which 1-2 existing players could pivot to capture it, and what to watch.`,
        `Prose and markdown lists only. Attribute claims; never invent figures.`,
      ].join('\n'),
      { system: GROUNDED_SYSTEM },
    );
    this.snap.opportunity[marketId] = {
      markdown: g.text,
      citations: g.citations,
      at: new Date().toISOString(),
    };
    this.persist();
    return { markdown: g.text, citations: g.citations };
  }

  subscribeDeckRefresh(listener: DeckRefreshListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: DeckRefreshEvent): void {
    for (const l of this.listeners) l(event);
  }
}
