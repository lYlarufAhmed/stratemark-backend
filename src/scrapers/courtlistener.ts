import type { ScrapedChange } from '../types.js';

export async function scrapeCourtListener(
  companyId: string,
  companyName: string,
): Promise<ScrapedChange[]> {
  const query = encodeURIComponent(`"${companyName}"`);
  const url = `https://www.courtlistener.com/api/rest/v3/dockets/?q=${query}`;
  const changes: ScrapedChange[] = [];

  try {
    const res = await fetch(url);
    if (!res.ok) return changes;
    const data = await res.json();
    const results = data?.results ?? [];

    for (const docket of results) {
      const caseName = docket.case_name || 'CourtListener Docket';
      const path = docket.absolute_url || '';
      const sourceUrl = path.startsWith('http')
        ? path
        : path
        ? `https://www.courtlistener.com${path}`
        : null;

      changes.push({
        companyId,
        companyName,
        sourceUrl,
        sourceTitle: caseName,
        rawText: docket.summary || docket.case_name || docket.docket_number || companyName,
        discoveredAt: docket.date_filed || new Date().toISOString(),
      });
    }
  } catch {
    // Silently skip on error
  }

  return changes;
}
