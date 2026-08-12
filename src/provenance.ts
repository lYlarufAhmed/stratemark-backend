import { publisherOf, usableCitations } from '@mi/contracts';
import type { AlertConfidence, ClassifiedChange, SentinelAlert } from './types.js';

export const UNSOURCED_DOWNGRADE_NOTE =
  'Confidence lowered automatically: Gemini classified this change but no verifiable source URL was found.';

export function enforceAlertProvenance(
  change: ClassifiedChange,
  userId: string,
): SentinelAlert {
  const citations = change.sourceUrl
    ? usableCitations([{ url: change.sourceUrl, title: change.sourceTitle }])
    : [];

  const hasEvidence = citations.length > 0;

  let confidence: AlertConfidence = 'unknown';
  if (hasEvidence) {
    const url = citations[0].url;
    const isPrimary = /sec\.gov|edgar|pacer|court|gov/i.test(url);
    confidence = isPrimary ? 'sourced-primary' : 'reported-secondary';
  }

  const sourceUrl = citations[0]?.url ?? null;
  const sourceTitle = citations[0]
    ? publisherOf(citations[0].url, citations[0].title)
    : 'Publisher not recorded';

  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    companyId: change.companyId,
    companyName: change.companyName,
    changeType: change.changeType,
    confidence,
    sourceUrl,
    sourceTitle,
    summary: change.summary,
    stateDeltaNote: change.stateDeltaNote,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  };
}

export function enforceAlertsProvenance(
  changes: ClassifiedChange[],
  userId: string,
): SentinelAlert[] {
  return changes.map((c) => enforceAlertProvenance(c, userId));
}
