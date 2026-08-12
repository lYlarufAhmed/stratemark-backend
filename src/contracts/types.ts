/** TypeScript types inferred from the Zod schemas — one source of truth. */
import type { z } from 'zod';
import type {
  boardMemberSchema,
  brandThemeSchema,
  capTableSliceSchema,
  cardSchema,
  companyMetricSchema,
  companySchema,
  deckSchema,
  historyContentSchema,
  liveIntelContentSchema,
  liveIntelItemSchema,
  liveLandingContentSchema,
  marketSchema,
  metricsContentSchema,
  missionGovernanceContentSchema,
  orgNodeSchema,
  overviewContentSchema,
  productSchema,
  productsRoadmapContentSchema,
  quoteSchema,
  roadmapItemSchema,
  scopeDefinitionSchema,
  teamOrgContentSchema,
  timelineEventSchema,
  timePointSchema,
  viceClaimSchema,
} from './schemas';
import type { DashboardTab } from './enums';

export type ScopeDefinition = z.infer<typeof scopeDefinitionSchema>;
export type Market = z.infer<typeof marketSchema>;
export type Deck = z.infer<typeof deckSchema>;
export type BrandTheme = z.infer<typeof brandThemeSchema>;
export type Company = z.infer<typeof companySchema>;
export type CompanyMetric = z.infer<typeof companyMetricSchema>;
export type Card = z.infer<typeof cardSchema>;
export type ViceClaim = z.infer<typeof viceClaimSchema>;

export type OverviewContent = z.infer<typeof overviewContentSchema>;
export type LiveIntelItem = z.infer<typeof liveIntelItemSchema>;
export type LiveIntelContent = z.infer<typeof liveIntelContentSchema>;
export type OrgNode = z.infer<typeof orgNodeSchema>;
export type TeamOrgContent = z.infer<typeof teamOrgContentSchema>;
export type LiveLandingContent = z.infer<typeof liveLandingContentSchema>;
export type TimePoint = z.infer<typeof timePointSchema>;
export type CapTableSlice = z.infer<typeof capTableSliceSchema>;
export type MetricsContent = z.infer<typeof metricsContentSchema>;
export type BoardMember = z.infer<typeof boardMemberSchema>;
export type MissionGovernanceContent = z.infer<typeof missionGovernanceContentSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type HistoryContent = z.infer<typeof historyContentSchema>;
export type Product = z.infer<typeof productSchema>;
export type RoadmapItem = z.infer<typeof roadmapItemSchema>;
export type ProductsRoadmapContent = z.infer<typeof productsRoadmapContentSchema>;

/** Strongly-typed map from tab id → its content payload type. */
export interface DashboardContentMap {
  overview: OverviewContent;
  live_intel: LiveIntelContent;
  team_org: TeamOrgContent;
  live_landing: LiveLandingContent;
  metrics: MetricsContent;
  mission_governance: MissionGovernanceContent;
  history: HistoryContent;
  products_roadmap: ProductsRoadmapContent;
}

export type DashboardContentFor<T extends DashboardTab> = DashboardContentMap[T];
