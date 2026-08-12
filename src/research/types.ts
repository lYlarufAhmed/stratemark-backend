/**
 * Types for the agentic research pipeline. Everything the pipeline emits is
 * shaped to the @mi/contracts domain types so it flows straight into the UI
 * (and is Zod-validated before it does).
 */
import type { ZodType, ZodTypeDef } from 'zod';
import type {
  CardType,
  CardWithCompany,
  DashboardTab,
  Deck,
  Market,
  SourceCredibility,
} from '@mi/contracts';

/** What the user submits from the "New deck" screen. */
export interface ResearchBrief {
  /** Free-text market description, e.g. "Christian apparel companies". */
  prompt: string;
  /** Optional geography/region scope, e.g. "California, USA". */
  region: string | null;
}

/** Normalized market definition (output of the scope-interpreter step). */
export interface MarketPlan {
  marketName: string;
  vertical: string;
  geography: string | null;
  notes: string | null;
  /** Angles the discovery step should search along. */
  searchThemes: string[];
}

export interface ResearchResumeState {
  plan: MarketPlan;
  market: Market;
  deck: Deck;
  candidates: CompanyCandidate[];
  completedCards: CardWithCompany[];
}

/** A grounded source (from Gemini's Google-Search grounding metadata). */
export interface Citation {
  title: string;
  url: string;
  credibility?: SourceCredibility;
}

/** A discovered company before full enrichment. */
export interface CompanyCandidate {
  name: string;
  /** Root domain (drives the logo + live-site tab). */
  domain: string | null;
  descriptor: string;
  /** The single primary card class used for deck grouping and ranking. */
  primaryRole?: 'company' | 'infrastructure' | 'distribution';
  /** Which card type(s) this entity belongs to. */
  cardTypes: CardType[];
}

/** Progress events streamed to the UI so cards appear as they are researched. */
export type ResearchEvent =
  | { type: 'status'; step: ResearchStep; message: string; progress?: number }
  | { type: 'market'; market: MarketPlan }
  | { type: 'candidates'; candidates: CompanyCandidate[] }
  | { type: 'card'; card: CardWithCompany }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; total: number };

export type ResearchStep = 'interpret' | 'discover' | 'enrich' | 'barriers' | 'score' | 'assemble';

export type OnResearchEvent = (event: ResearchEvent) => void;

export interface GeminiConfig {
  apiKey?: string;
  /** Grounded/reasoning model (search-capable). */
  model?: string;
  /** Lighter model for structuring/extraction. Defaults to `model`. */
  structureModel?: string;
}

export interface ResearchCoverage {
  /** Primary operating companies; this is the hard minimum for a usable deck. */
  companies: { min: number; target: number; max: number };
  /** Suppliers and platforms the market depends on. */
  infrastructure: { min: number; target: number; max: number };
  /** Channels, marketplaces, resellers, and integrators. */
  distribution: { min: number; target: number; max: number };
  /** Sourced company-level signals, never invented to fill a quota. */
  vice: { min: number; target: number; max: number };
  culture: { min: number; target: number; max: number };
  /** Market-level claims from the shared market pass. */
  barrier: { min: number; target: number; max: number };
  insight: { min: number; target: number; max: number };
}

export interface RunResearchOptions extends GeminiConfig {
  onEvent?: OnResearchEvent;
  signal?: AbortSignal;
  /** Cap concurrent enrichment calls (free-tier friendly). Default 2. */
  concurrency?: number;
  /** Backward-compatible total entity target; coverage targets take precedence. */
  targetCompanies?: number;
  /** Explicit coverage policy; defaults to the free-tier-safe market profile. */
  coverage?: Partial<ResearchCoverage>;
  /** Maximum unique players retained in the market catalog before enrichment. */
  catalogMax?: number;
  /** Maximum catalog search-angle passes; defaults to the market's search themes. */
  catalogPasses?: number;
  /** Resume a durable job from its persisted catalog and completed cards. */
  resume?: ResearchResumeState;
}

/** The abstraction the pipeline steps talk to (implemented by the Gemini client). */
export interface LlmClient {
  /**
   * Grounded generation — ALWAYS sends the Google Search tool. Returns the
   * model's text plus the source citations Google attached. This is the only
   * way facts enter the pipeline (never from training data alone).
   */
  ground(
    prompt: string,
    opts?: { system?: string; signal?: AbortSignal },
  ): Promise<{ text: string; citations: Citation[]; queries: string[] }>;

  /**
   * Structured extraction — converts prior grounded text into strict JSON,
   * validated against a Zod schema. Not grounded (grounding + JSON mode can't be
   * combined in one call), so it must be given the grounded text to work from.
   */
  structure<T>(
    prompt: string,
    // Input param widened to `unknown` so T binds to the schema's OUTPUT type
    // (post-defaults), not its input type.
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts?: { system?: string; signal?: AbortSignal },
  ): Promise<T>;
}

export interface DashboardResearchResult<T extends DashboardTab> {
  tab: T;
  citations: Citation[];
}
