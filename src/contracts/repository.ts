/**
 * MarketIntelRepository — the transport-agnostic data contract.
 *
 * This is the seam between the UI and everything native. The renderer only ever
 * talks to this interface, so the exact same UI runs against:
 *   - MockRepository (in-memory fixtures) — today, the whole front-end phase
 *   - IpcRepository (Electron main ⇄ SQLite/Drizzle over IPC) — the real back end
 *   - (optionally) a cloud HTTP adapter later — no UI changes
 *
 * Swapping implementations is a one-line provider change (see the web app's
 * RepositoryProvider). Adding a method here is the single place the back end and
 * the UI agree on new capability.
 */
import type {
  CardType,
  Confidence,
  DashboardTab,
  MaturityTier,
  MetricType,
  RefreshCadence,
} from './enums';
import type {
  Card,
  Company,
  CompanyMetric,
  DashboardContentFor,
  Deck,
  Market,
  ScopeDefinition,
  ViceClaim,
} from './types';

export interface CreateMarketInput {
  name: string;
  scopeDefinition: ScopeDefinition;
  refreshCadence: RefreshCadence;
}

/** A user's free-text request to research a new deck (the "New deck" screen). */
export interface DeckResearchBrief {
  prompt: string;
  region: string | null;
}

export type ResearchStage = 'scope' | 'catalog' | 'summary' | 'metrics' | 'signals' | 'dashboard';
export type ResearchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResearchCatalogCandidate {
  name: string;
  domain: string | null;
  descriptor: string;
  primaryRole?: 'company' | 'infrastructure' | 'distribution';
  cardTypes: CardType[];
}

export interface ResearchJob {
  id: string;
  status: ResearchJobStatus;
  stage: ResearchStage;
  brief: DeckResearchBrief;
  marketPlan?: {
    marketName: string;
    vertical: string;
    geography: string | null;
    notes: string | null;
    searchThemes: string[];
  };
  market?: Market;
  deck?: Deck;
  catalog?: ResearchCatalogCandidate[];
  catalogNames: string[];
  completedEntityNames: string[];
  partialCards: CardWithCompany[];
  warnings: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProgress {
  message: string;
  /** High-level stage so consumers can reveal data progressively without UI coupling. */
  stage?: ResearchStage;
  /** 0..1 when known. */
  progress?: number;
  /** Log-line flavor for glass-box terminals: step (phase), find (discovery), warn. */
  kind?: 'step' | 'find' | 'warn';
  /** Partial card emitted as soon as its backend enrichment finishes. */
  card?: CardWithCompany;
}

export interface ResearchHandlers {
  onProgress?: (progress: ResearchProgress) => void;
  signal?: AbortSignal;
}

/** Source class used to decide whether evidence can support a verified claim. */
export type SourceCredibility =
  'primary' | 'reputable_secondary' | 'industry' | 'user_generated' | 'unknown';

/** A grounded source. */
export interface Citation {
  title: string;
  url: string;
  credibility?: SourceCredibility;
}

/** A focused "dig deeper" request on a company + a specific topic (spec: research-intuitive drill-down). */
export interface DeepDiveInput {
  companyId: string | null;
  companyName: string;
  /** The thing to expand on, e.g. "Annual Recurring Revenue", "the founding team". */
  topic: string;
  /** Optional extra framing (market name, current value, etc.). */
  context?: string | null;
}

export interface DeepDiveResult {
  markdown: string;
  citations: Citation[];
}

/** Grounded verification of a single claim (the "fact-check" action). */
export type FactCheckVerdict = 'supported' | 'contradicted' | 'unverified';

export interface FactCheckInput {
  /** The claim to verify, e.g. "Seedlip's ARR is $15M". */
  claim: string;
  companyName: string | null;
  context?: string | null;
}

export interface FactCheckResult {
  verdict: FactCheckVerdict;
  rationale: string;
  citations: Citation[];
}

/** A saved research report composed by the AI from deck/company evidence. */
export interface ReportRequest {
  kind: 'deck' | 'company';
  /** deckId when kind='deck'; companyId when kind='company'. */
  subjectId: string;
  /**
   * The user's framing for what the report should concentrate on
   * ("who is winning enterprise", "risks to a new entrant"). The evidence rules
   * don't change — focus steers emphasis, never sourcing.
   */
  focus?: string | null;
  /** Fold a research conversation's findings into the report. */
  threadId?: string | null;
}

// ---------------------------------------------------------------------------
// Research conversations — the "second brain" primitive.
//
// Every Dig starts (or continues) a thread: a grounded conversation anchored to
// something concrete — a deck, a company, a set of selected cards, or a single
// data point. Threads persist alongside the deck, so the questions an analyst
// asked become part of the deck's accumulated intelligence, and any thread can
// be distilled into a saved report.
// ---------------------------------------------------------------------------

export interface ResearchScope {
  kind: 'deck' | 'company' | 'cards' | 'datapoint';
  deckId: string | null;
  companyId?: string | null;
  /** Selected card ids for deck-level comparisons. */
  cardIds?: string[];
  /** Human label for what this thread is anchored to, e.g. "ARR", "GPT-5", "Jane Doe". */
  subject?: string | null;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Grounded sources behind an assistant turn. Always [] for user turns. */
  citations: Citation[];
  at: string;
}

export interface ResearchThread {
  id: string;
  scope: ResearchScope;
  title: string;
  messages: ThreadMessage[];
  /** Set when the thread has been distilled into a saved report. */
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AskResearchInput {
  /** Continue an existing thread… */
  threadId?: string;
  /** …or start a new one anchored to this scope. */
  scope?: ResearchScope;
  question: string;
}

export interface Report {
  id: string;
  kind: 'deck' | 'company';
  subjectId: string;
  title: string;
  markdown: string;
  citations: Citation[];
  /** The compact, source-linked evidence digest the report was allowed to use. */
  evidenceDigest?: string;
  evidenceCitations?: Citation[];
  createdAt: string;
}

/** Targeted micro-research to fill a gap in an existing deck (intelligent empty states). */
export interface ExpandFocus {
  tier?: MaturityTier;
  cardType?: CardType;
}

/** A conflicting observation retained when repeated research disagrees. */
export interface MetricConflict {
  metricType: MetricType;
  observations: Array<{
    value: number | null;
    confidence: Confidence;
    source: string | null;
    capturedAt: string;
  }>;
  detectedAt: string;
  preferredObservation: number;
}

/** A user's manual correction to a metric (human-in-the-loop override). */
export interface OverrideMetricInput {
  companyId: string;
  metricType: MetricType;
  /** Raw number (USD for money, count for users/employees, percent for share); null clears to Unknown. */
  value: number | null;
  /** The user's source note, e.g. "Confirmed by their VP Sales at dinner 07/2026". */
  note: string | null;
}

export interface CardFilter {
  cardType?: CardType;
  tier?: MaturityTier;
}

/** A card denormalized with everything the card face + reader needs in one shot. */
export interface CardWithCompany {
  card: Card;
  company: Company | null; // null for Barrier cards (not company-specific, spec §4)
  metrics: CompanyMetric[];
  viceClaims: ViceClaim[]; // populated only for Vice cards
}

export interface DashboardTabResult<T extends DashboardTab> {
  companyId: string;
  tab: T;
  content: DashboardContentFor<T>;
  lastRefreshedAt: string | null;
}

/** Emitted after a deck refresh so the UI can reconcile without a full refetch (spec §9). */
export interface DeckRefreshEvent {
  marketId: string;
  deckId: string;
  refreshedAt: string;
  addedCardIds: string[];
  updatedCardIds: string[];
  prunedCardIds: string[];
}

export type DeckRefreshListener = (event: DeckRefreshEvent) => void;
export type Unsubscribe = () => void;

export interface SavedCard {
  cardId: string;
  savedAt: string;
}

export interface MarketIntelRepository {
  // Markets
  listMarkets(): Promise<Market[]>;
  getMarket(id: string): Promise<Market | null>;
  createMarket(input: CreateMarketInput): Promise<Market>;
  updateMarketCadence(id: string, cadence: RefreshCadence): Promise<Market>;

  // Decks
  getDeckByMarket(marketId: string): Promise<Deck | null>;
  /** Re-run the grounded-search research pass for the market scope (spec §9). */
  refreshDeck(marketId: string): Promise<Deck>;
  /**
   * Research a brand-new deck from a free-text brief (grounded pipeline).
   * Real implementations run Gemini; the demo implementation returns a sample.
   */
  createResearchedDeck(
    brief: DeckResearchBrief,
    handlers?: ResearchHandlers,
  ): Promise<{ market: Market; deck: Deck }>;

  // Cards
  listCards(deckId: string, filter?: CardFilter): Promise<CardWithCompany[]>;
  getCard(cardId: string): Promise<CardWithCompany | null>;
  listSavedCards(): Promise<CardWithCompany[]>;
  saveCard(cardId: string): Promise<SavedCard>;
  unsaveCard(cardId: string): Promise<void>;

  // Company detail
  getCompany(companyId: string): Promise<Company | null>;
  getCompanyMetrics(companyId: string): Promise<CompanyMetric[]>;
  getViceClaims(cardId: string): Promise<ViceClaim[]>;

  // Dashboard (spec §8)
  getDashboardTab<T extends DashboardTab>(
    companyId: string,
    tab: T,
    /** Bypass the cached result and re-research this tab (user-directed rerun). */
    force?: boolean,
  ): Promise<DashboardTabResult<T> | null>;

  /** Grounded, sourced deep-dive on a specific topic — the "dig deeper" drill-down. */
  deepDive(input: DeepDiveInput): Promise<DeepDiveResult>;

  /** Grounded verification of a single claim — verdict + rationale + sources. */
  factCheck(input: FactCheckInput): Promise<FactCheckResult>;

  /** Fill a gap in a deck via targeted micro-research (e.g. hunt Seed-stage companies). */
  expandDeck(
    marketId: string,
    focus: ExpandFocus,
    handlers?: ResearchHandlers,
  ): Promise<{ added: number }>;

  /** Human-in-the-loop metric correction → confidence 'user_verified' → CMS re-tier. */
  overrideMetric(input: OverrideMetricInput): Promise<CompanyMetric>;

  /** Deck-level whitespace analysis (2×2 positioning thesis), grounded + cached. */
  getMarketOpportunity(marketId: string, force?: boolean): Promise<DeepDiveResult>;

  // Reports — AI-composed research artifacts, kept in an organized library.
  generateReport(request: ReportRequest, handlers?: ResearchHandlers): Promise<Report>;
  listReports(): Promise<Report[]>;
  getReport(id: string): Promise<Report | null>;

  // Research conversations. OPTIONAL so transports can adopt incrementally
  // (the Electron IPC bridge wires these when the desktop back end lands);
  // the UI feature-detects and hides chat affordances when absent.
  /** Ask a grounded question in a new or existing research thread. */
  askResearch?(input: AskResearchInput, handlers?: ResearchHandlers): Promise<ResearchThread>;
  /** Threads anchored to a deck and/or company, newest first. */
  listResearchThreads?(filter?: { deckId?: string; companyId?: string }): Promise<ResearchThread[]>;
  getResearchThread?(id: string): Promise<ResearchThread | null>;
  /** Durable research-job controls used by Electron and future orchestration agents. */
  listResearchJobs?(): Promise<ResearchJob[]>;
  getResearchJob?(id: string): Promise<ResearchJob | null>;
  cancelResearchJob?(id: string): Promise<ResearchJob | null>;
  resumeResearchJob?(id: string): Promise<ResearchJob | null>;
  /** Distill a conversation into a saved report (kept in the library + thread link). */
  saveThreadAsReport?(threadId: string, focus?: string | null): Promise<Report>;

  // Live refresh stream (spec §9). No-op-unsubscribe implementations are valid.
  subscribeDeckRefresh(listener: DeckRefreshListener): Unsubscribe;
}

// ---------------------------------------------------------------------------
// User-isolated Firestore path utilities
// ---------------------------------------------------------------------------

export const USER_SCOPED_COLLECTIONS = {
  MARKETS: 'markets',
  DECKS: 'decks',
  CARDS: 'cards',
  COMPANIES: 'companies',
  METRICS: 'metrics',
  VICE_CLAIMS: 'viceClaims',
  ALERTS: 'alerts',
} as const;

export type UserScopedCollectionName =
  (typeof USER_SCOPED_COLLECTIONS)[keyof typeof USER_SCOPED_COLLECTIONS];

/** Construct user root path: /users/{userId} */
export function getUserPath(userId: string): string {
  return `users/${userId}`;
}

/** Construct user collection path: /users/{userId}/{collection} */
export function getUserCollectionPath(
  userId: string,
  collection: UserScopedCollectionName | string,
): string {
  return `users/${userId}/${collection}`;
}

/** Construct user document path: /users/{userId}/{collection}/{docId} */
export function getUserDocumentPath(
  userId: string,
  collection: UserScopedCollectionName | string,
  docId: string,
): string {
  return `users/${userId}/${collection}/${docId}`;
}

/** Construct market path: /users/{userId}/markets/{marketId} */
export function getUserMarketPath(userId: string, marketId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.MARKETS, marketId);
}

/** Construct deck path: /users/{userId}/decks/{deckId} */
export function getUserDeckPath(userId: string, deckId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.DECKS, deckId);
}

/** Construct card path: /users/{userId}/cards/{cardId} */
export function getUserCardPath(userId: string, cardId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.CARDS, cardId);
}

/** Construct company path: /users/{userId}/companies/{companyId} */
export function getUserCompanyPath(userId: string, companyId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.COMPANIES, companyId);
}

/** Construct metric path: /users/{userId}/metrics/{metricId} */
export function getUserMetricPath(userId: string, metricId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.METRICS, metricId);
}

/** Construct company-nested metric path: /users/{userId}/companies/{companyId}/metrics/{metricId} */
export function getUserCompanyMetricPath(
  userId: string,
  companyId: string,
  metricId: string,
): string {
  return `users/${userId}/companies/${companyId}/metrics/${metricId}`;
}

/** Construct vice claim path: /users/{userId}/viceClaims/{viceClaimId} */
export function getUserViceClaimPath(userId: string, viceClaimId: string): string {
  return getUserDocumentPath(userId, USER_SCOPED_COLLECTIONS.VICE_CLAIMS, viceClaimId);
}

/** Construct card-nested vice claim path: /users/{userId}/cards/{cardId}/viceClaims/{viceClaimId} */
export function getUserCardViceClaimPath(
  userId: string,
  cardId: string,
  viceClaimId: string,
): string {
  return `users/${userId}/cards/${cardId}/viceClaims/${viceClaimId}`;
}
