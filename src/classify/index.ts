import { config } from '../config.js';
import type { ScrapedChange, ClassifiedChange, ChangeType, SentinelAlert } from '../types.js';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export async function classifyChange(
  change: ScrapedChange,
  recentAlerts: SentinelAlert[] = [],
): Promise<ClassifiedChange> {
  const previousAlertsSummary = recentAlerts.length > 0
    ? recentAlerts
        .map((a) => `- [${a.createdAt.split('T')[0]}] (${a.changeType}) ${a.summary}`)
        .join('\n')
    : 'None';

  const prompt = `Classify this competitor change and generate a 2-sentence summary. Also check for duplicate re-reporting versus material state progression against PREVIOUS_ALERTS from the last 30 days.

Company: ${change.companyName}
Source: ${change.sourceTitle}
URL: ${change.sourceUrl}
Text: ${change.rawText}

PREVIOUS_ALERTS (Last 30 days):
${previousAlertsSummary}

Respond in JSON:
{
  "changeType": "regulatory|funding|hiring|pricing|product|other",
  "confidence": 0.0-1.0,
  "summary": "2-sentence summary of the change",
  "isDuplicate": boolean (true if this exact event with no new state progression was already reported in PREVIOUS_ALERTS),
  "isStateUpdate": boolean (true if this represents a material state transition/ruling/progress on a previously reported event),
  "stateDeltaNote": "Optional 1-sentence explanation of what changed compared to previous intel"
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      },
    );

    if (!res.ok) {
      return fallbackClassify(change);
    }

    const data: GeminiResponse = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);

    const isDuplicate = Boolean(parsed.isDuplicate);
    const isStateUpdate = Boolean(parsed.isStateUpdate);

    return {
      ...change,
      changeType: validateChangeType(parsed.changeType),
      confidence: isDuplicate ? 0.1 : clamp(parsed.confidence ?? 0.5),
      summary: parsed.summary ?? `${change.companyName} — ${change.sourceTitle}`,
      isDuplicate,
      isStateUpdate,
      stateDeltaNote: parsed.stateDeltaNote ?? undefined,
    };
  } catch {
    return fallbackClassify(change);
  }
}

export async function classifyChanges(
  changes: ScrapedChange[],
  recentAlerts: SentinelAlert[] = [],
): Promise<ClassifiedChange[]> {
  return Promise.all(changes.map((change) => classifyChange(change, recentAlerts)));
}

function fallbackClassify(change: ScrapedChange): ClassifiedChange {
  return {
    ...change,
    changeType: 'other',
    confidence: 0.3,
    summary: `${change.companyName} — ${change.sourceTitle}`,
    isDuplicate: false,
    isStateUpdate: false,
  };
}

function validateChangeType(type: string): ChangeType {
  const valid: ChangeType[] = ['regulatory', 'funding', 'hiring', 'pricing', 'product', 'other'];
  return valid.includes(type as ChangeType) ? (type as ChangeType) : 'other';
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
