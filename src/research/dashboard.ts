/**
 * Lazy, per-tab dashboard research (spec §8). Called only when a user opens a
 * company tab, so a deck of N companies doesn't burn 8×N grounded calls up front
 * (free-tier discipline). Text tabs are grounded then structured; Metrics is
 * built from the already-researched point metrics (no fabricated time series);
 * Live Landing is computed locally.
 */
import { z } from 'zod';
import {
  historyContentSchema,
  missionGovernanceContentSchema,
  overviewContentSchema,
  productsRoadmapContentSchema,
  teamOrgContentSchema,
  type Company,
  type CompanyMetric,
  type DashboardContentMap,
  type DashboardTab,
  type MetricsContent,
} from '@mi/contracts';
import { GROUNDED_SYSTEM, STRUCTURE_SYSTEM } from './prompts';
import type { LlmClient } from './types';

export interface TabResearchArgs {
  company: Company;
  marketName: string;
  storedMetrics: CompanyMetric[];
  client: LlmClient;
  signal?: AbortSignal;
}

const ctx = (a: TabResearchArgs): string =>
  `${a.company.name}${a.company.websiteUrl ? ` (${a.company.websiteUrl})` : ''}, a company in the market "${a.marketName}".`;

// Loose intermediate for live intel (server sets timestamps/stale).
const liveIntelItemsSchema = z.object({
  items: z
    .array(
      z.object({
        source: z.enum(['news', 'x', 'reddit']).default('news'),
        title: z.string(),
        url: z.string().default(''),
        summary: z.string().default(''),
        sentiment: z.enum(['positive', 'neutral', 'negative']).default('neutral'),
      }),
    )
    .default([]),
});

function metricsFromStored(metrics: CompanyMetric[]): MetricsContent {
  const val = (t: string) => metrics.find((m) => m.metricType === t)?.value ?? null;
  const arr = val('arr');
  const users = val('users');
  // Honest: single current data points from grounded research, not invented series.
  return {
    revenue: arr != null ? [{ period: 'Current', value: arr }] : [],
    users: users != null ? [{ period: 'Current', value: users }] : [],
    churn: [],
    nps: [],
    capTable: [],
  };
}

export async function researchDashboardTab<T extends DashboardTab>(
  tab: T,
  args: TabResearchArgs,
): Promise<DashboardContentMap[T]> {
  const { client, signal } = args;
  const system = { system: GROUNDED_SYSTEM, signal };
  const structSys = { system: STRUCTURE_SYSTEM, signal };

  switch (tab) {
    case 'live_landing':
      return {
        url: args.company.websiteUrl ?? '',
        embeddable: true, // the tab detects blocked embedding at runtime
        screenshotUrl: null,
      } as DashboardContentMap[T];

    case 'metrics':
      return metricsFromStored(args.storedMetrics) as DashboardContentMap[T];

    case 'overview': {
      const g = await client.ground(
        `Write a concise, sourced one-page overview of ${ctx(args)} — what it does, how it competes, why it matters, and WHO ITS TARGET CUSTOMER IS (the buyer it actually sells to, as specifically as the sources support). Ground every claim.`,
        system,
      );
      return client.structure(
        `Convert to JSON { "markdown": string } using GitHub-flavored markdown with a short intro, then "## What they do", "## Who they sell to" (their target customer, from the notes), and "## Why it matters" sections.\n\nNOTES:\n${g.text}`,
        overviewContentSchema,
        structSys,
      ) as Promise<DashboardContentMap[T]>;
    }

    case 'live_intel': {
      const g = await client.ground(
        `Find the most recent news, X/Twitter, and Reddit discussion about ${ctx(args)} (last few weeks). Surface 12–18 DISTINCT items — separate stories, threads, and announcements, not variations of one story — mixing all three source types where they exist. For each, note the source type, headline, URL, a one-line summary, and sentiment. If fewer genuinely exist, return only what is real; never pad.`,
        system,
      );
      const loose = await client.structure(
        `Convert to JSON { "items": [ { "source": "news"|"x"|"reddit", "title", "url", "summary", "sentiment": "positive"|"neutral"|"negative" } ] }.\n\nNOTES:\n${g.text}`,
        liveIntelItemsSchema,
        structSys,
      );
      const nowIso = new Date().toISOString();
      return {
        items: loose.items.map((it, i) => ({
          id: `${args.company.id}-intel-${i}`,
          source: it.source,
          title: it.title,
          url: it.url,
          summary: it.summary,
          sentiment: it.sentiment,
          publishedAt: nowIso,
          stale: false,
        })),
        lastRefreshedAt: nowIso,
        cadence: 'weekly',
      } as DashboardContentMap[T];
    }

    case 'team_org': {
      const g = await client.ground(
        `Identify the leadership and key org structure of ${ctx(args)} — founders, C-suite, and heads of product/AI/design where known. Note who reports to whom, and for each person one or two sentences of reported background (prior roles, tenure, what they own) where the sources actually say it.`,
        system,
      );
      const out = await client.structure(
        `Convert to JSON { "nodes": [ { "id" (short slug), "name", "role", "group": "exec"|"ai"|"product"|"design"|"other", "parentId" (id of manager or null), "bio" (1-2 reported sentences, or "" when the notes say nothing about the person) } ] }. The top leader has parentId null. Never invent a bio.\n\nNOTES:\n${g.text}`,
        teamOrgContentSchema,
        structSys,
      );
      // Guard referential integrity: drop parentIds that don't resolve.
      const ids = new Set(out.nodes.map((n) => n.id));
      return {
        nodes: out.nodes.map((n) => ({ ...n, parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null })),
      } as DashboardContentMap[T];
    }

    case 'mission_governance': {
      const g = await client.ground(
        `Research the mission, ethos, governance/board, and a balanced view of notable positive and negative actions of ${ctx(args)}. Cite sources.`,
        system,
      );
      return client.structure(
        `Convert to JSON { "mission", "ethos", "governanceStructure", "board": [ { "name", "affiliation" } ], "positives": string[], "negatives": string[] }. Only include facts supported by the notes.\n\nNOTES:\n${g.text}`,
        missionGovernanceContentSchema,
        structSys,
      ) as Promise<DashboardContentMap[T]>;
    }

    case 'history': {
      const g = await client.ground(
        `Research the company story and timeline of ${ctx(args)}: the founding story written as a short readable narrative, then key dated milestones from inception to now — funding, launches, pivots, stumbles. For a company only a few years old prefer quarterly-level milestones; for an older company yearly is right. Include notable quotes. Cite sources.`,
        system,
      );
      return client.structure(
        `Convert to JSON { "founderStory" (a well-written multi-paragraph narrative of where the company came from — the one-pager story), "timeline": [ { "date" (e.g. "2023 Q4" or "2019"), "title", "detail" (one or two lines) } ] in chronological order, "quotes": [ { "text", "attribution" } ] }.\n\nNOTES:\n${g.text}`,
        historyContentSchema,
        structSys,
      ) as Promise<DashboardContentMap[T]>;
    }

    case 'products_roadmap': {
      const g = await client.ground(
        `Research the full product lineup of ${ctx(args)} — every distinct product/line, what each consists of, and anything REPORTED about how much revenue each drives (filings, earnings coverage, credible reporting). Then any announced roadmap/expansion plans and the direction they point. Cite sources.`,
        system,
      );
      return client.structure(
        `Convert to JSON { "products": [ { "name", "description", "status": "live"|"beta"|"sunset", "revenueNote" (what the notes REPORT about its revenue contribution, e.g. "~78% of FY25 revenue per 10-K" — or "" when nothing is reported; NEVER an invented figure) } ] ordered from biggest reported breadwinner to smallest/loss-leaders (keep unranked ones last), "roadmap": [ { "title", "horizon": "now"|"next"|"later", "detail" } ] }.\n\nNOTES:\n${g.text}`,
        productsRoadmapContentSchema,
        structSys,
      ) as Promise<DashboardContentMap[T]>;
    }
  }
  // Exhaustive — all tabs handled above.
  throw new Error(`Unhandled dashboard tab: ${String(tab)}`);
}
