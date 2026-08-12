/**
 * Provenance enforcement — the product's central promise, in code.
 *
 * Audit finding (2026-07-29): 3 of 29 metrics labelled `verified` in a real
 * research run carried **no citation at all**. The model had claimed high
 * confidence without pointing at a source, and nothing downstream objected. For
 * a tool people make financial decisions on, that is the worst possible bug: it
 * is indistinguishable from an invented number.
 *
 * So "verified" is no longer something a model can simply assert. It is a
 * *derived* state that requires evidence, enforced here and applied at every
 * point a metric is created or updated.
 */
import type { Confidence } from './enums';
import type { Citation, MetricConflict, SourceCredibility } from './repository';
import type { CompanyMetric } from './types';

/** Reason text stamped on a figure that lost its "verified" claim. */
export const UNSOURCED_DOWNGRADE_NOTE =
  'Confidence lowered automatically: the research pass claimed this figure was verified but returned no source for it.';

/**
 * Confidence levels a model is allowed to assert on its own.
 * `verified` is absent by design — it must be earned with a citation.
 * `user_verified` is absent too: only a human override may set it.
 */
const MODEL_ASSERTABLE: readonly Confidence[] = ['estimated', 'unknown'];

export function isModelAssertable(confidence: Confidence): boolean {
  return MODEL_ASSERTABLE.includes(confidence);
}

/** Drop citations that can't be shown or clicked. */
export function usableCitations(citations: readonly Citation[] | undefined): Citation[] {
  if (!citations) return [];
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const url = (c?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: (c.title ?? '').trim() || publisherOf(url),
      credibility: c.credibility ?? classifySource(url, c.title),
    });
  }
  return out;
}

/**
 * Human-readable publisher for a citation URL.
 *
 * Grounded citations arrive as `vertexaisearch.cloud.google.com/grounding-api-
 * redirect/...`, which tells a user nothing. Google supplies the real publisher
 * in the citation title, so prefer that; fall back to the hostname.
 */
export function publisherOf(url: string, title?: string | null): string {
  const t = (title ?? '').trim();
  if (t && !/vertexaisearch|grounding-api-redirect/i.test(t)) return t;
  // A redirect with no usable title means the publisher was never recorded.
  // Showing "vertexaisearch.cloud.google.com" would imply Google published the
  // figure, which is false and worse than admitting the gap.
  if (isRedirectCitation(url)) return UNRECORDED_PUBLISHER;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

/** Shown when a citation survived but the publisher name did not. */
export const UNRECORDED_PUBLISHER = 'Publisher not recorded';

/**
 * Classify a source conservatively. This is a routing signal, not a claim that a
 * publisher is always correct: verified still requires the source to state the
 * exact figure and survive provenance enforcement.
 */
export function classifySource(url: string, title?: string | null): SourceCredibility {
  const haystack = `${url} ${title ?? ''}`.toLowerCase();
  if (/sec\.gov|secfilings|edgar|pacer\.uscourts\.gov|investor\.[^\s/]+/.test(haystack))
    return 'primary';
  if (
    /reuters|bloomberg|wsj\.com|ft\.com|apnews|nytimes|bbc\.com|economist\.com|associated press/.test(
      haystack,
    )
  ) {
    return 'reputable_secondary';
  }
  if (
    /techcrunch|theinformation|crunchbase|pitchbook|venturebeat|wired|arstechnica|statista/.test(
      haystack,
    )
  ) {
    return 'industry';
  }
  if (/reddit|twitter\.com|x\.com|facebook|instagram|tiktok|quora|forum/.test(haystack))
    return 'user_generated';
  return 'unknown';
}

/** True when a citation URL is an opaque grounding redirect (may expire). */
export function isRedirectCitation(url: string): boolean {
  return /vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i.test(url);
}

/**
 * Bring a freshly-researched metric in line with the provenance rules.
 *
 * - `verified` without a usable citation is demoted to `estimated` and stamped
 *   with why. It is never silently kept, and never promoted.
 * - `user_verified` is preserved: a human said so, which outranks the model.
 * - `unknown` must not carry a value (an unknown with a number is a contradiction).
 * - `source` is kept in sync with the first citation.
 */
export function enforceMetricProvenance(metric: CompanyMetric): CompanyMetric {
  const citations = usableCitations(metric.citations);
  // Evidence is either a clickable citation OR a written attribution the reader
  // can weigh ("company's published team page"). What's forbidden is a
  // "verified" claim backed by *nothing* — that's indistinguishable from an
  // invented number, and it's the bug the 2026-07-29 audit found 3 of.
  const proseSource = (metric.source ?? '').trim();
  const hasEvidence = citations.length > 0 || proseSource.length > 0;

  let confidence = metric.confidence;
  let methodNote = metric.methodNote;

  if (confidence === 'verified' && !hasEvidence) {
    confidence = 'estimated';
    methodNote = methodNote
      ? `${methodNote} — ${UNSOURCED_DOWNGRADE_NOTE}`
      : UNSOURCED_DOWNGRADE_NOTE;
  }

  // An "unknown" figure cannot carry a number.
  const value = confidence === 'unknown' ? null : metric.value;
  // Conversely, a null value can only be unknown or a deliberate human override.
  if (value === null && confidence !== 'unknown' && confidence !== 'user_verified') {
    confidence = 'unknown';
  }

  return {
    ...metric,
    value,
    confidence,
    citations,
    // Prefer a clickable citation; otherwise keep whatever written attribution
    // exists so the reader can still see where the figure came from.
    source: citations[0]?.url ?? (proseSource.length > 0 ? proseSource : null),
    methodNote,
  };
}

function evidenceWeight(metric: CompanyMetric): number {
  const sourceWeight: Record<SourceCredibility, number> = {
    primary: 100,
    reputable_secondary: 90,
    industry: 70,
    user_generated: 20,
    unknown: 10,
  };
  const credibility = metric.citations[0]?.credibility ?? classifySource(metric.source ?? '', '');
  const confidenceWeight =
    metric.confidence === 'user_verified'
      ? 40
      : metric.confidence === 'verified'
        ? 30
        : metric.confidence === 'estimated'
          ? 20
          : 0;
  return (sourceWeight[credibility] ?? 0) + confidenceWeight;
}

/**
 * Merge a newly researched metric into the canonical row. Contradictory values
 * are never silently discarded: both observations are retained, while the most
 * credible observation becomes the canonical value used by existing cards/tabs.
 */
export function reconcileMetric(existing: CompanyMetric, incoming: CompanyMetric): CompanyMetric {
  const current = enforceMetricProvenance(existing);
  const next = enforceMetricProvenance(incoming);
  if (current.value === next.value || next.value === null) {
    return {
      ...current,
      ...(next.value !== null ? next : {}),
      revision: (current.revision ?? 0) + 1,
    };
  }
  const observations = [
    {
      value: current.value,
      confidence: current.confidence,
      source: current.source,
      capturedAt: current.capturedAt,
    },
    {
      value: next.value,
      confidence: next.confidence,
      source: next.source,
      capturedAt: next.capturedAt,
    },
  ];
  const preferredObservation = evidenceWeight(next) > evidenceWeight(current) ? 1 : 0;
  const conflict: MetricConflict = {
    metricType: current.metricType,
    observations,
    detectedAt: new Date().toISOString(),
    preferredObservation,
  };
  const preferred = preferredObservation === 1 ? next : current;
  return {
    ...preferred,
    conflicts: [...(current.conflicts ?? []), ...(next.conflicts ?? []), conflict],
    revision: Math.max(current.revision ?? 0, next.revision ?? 0) + 1,
  };
}

/** Reconcile all metrics for one company and keep one canonical row per type. */
export function reconcileMetrics(
  existing: CompanyMetric[],
  incoming: CompanyMetric[],
): CompanyMetric[] {
  const byType = new Map(existing.map((metric) => [metric.metricType, metric]));
  for (const metric of incoming) {
    const current = byType.get(metric.metricType);
    byType.set(
      metric.metricType,
      current ? reconcileMetric(current, metric) : enforceMetricProvenance(metric),
    );
  }
  return [...byType.values()];
}

/** Convenience for whole rows at once. */
export function enforceMetricsProvenance(metrics: CompanyMetric[]): CompanyMetric[] {
  return metrics.map(enforceMetricProvenance);
}
