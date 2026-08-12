import type { ScrapedChange } from '../types.js';
import { scrapeCourtListener } from './courtlistener.js';

export { scrapeCourtListener };

export async function scrapeEdgar(cik: string, companyName: string): Promise<ScrapedChange[]> {
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(companyName)}%22&dateRange=custom&startdt=${daysAgo(1)}&enddt=${today()}`;
  const changes: ScrapedChange[] = [];

  try {
    const res = await fetch(url);
    if (!res.ok) return changes;
    const data = await res.json();
    const hits = data?.hits?.hits ?? [];

    for (const hit of hits) {
      const source = hit._source;
      changes.push({
        companyId: cik,
        companyName,
        sourceUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${source.file_num}`,
        sourceTitle: source.display_names?.[0] ?? 'SEC EDGAR',
        rawText: source.file_description ?? source.display_names?.join(', ') ?? '',
        discoveredAt: new Date().toISOString(),
      });
    }
  } catch {
    // Silently skip failed scrapes — log but don't crash
  }

  return changes;
}

export async function scrapeGoogleNews(
  companyId: string,
  companyName: string,
): Promise<ScrapedChange[]> {
  const query = encodeURIComponent(`"${companyName}"`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const changes: ScrapedChange[] = [];

  try {
    const res = await fetch(url);
    if (!res.ok) return changes;
    const text = await res.text();

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null) {
      const item = match[1];
      const title = extractTag(item, 'title');
      const link = extractTag(item, 'link');
      const pubDate = extractTag(item, 'pubDate');

      if (title && link) {
        changes.push({
          companyId,
          companyName,
          sourceUrl: link,
          sourceTitle: title,
          rawText: title,
          discoveredAt: pubDate ?? new Date().toISOString(),
        });
      }
    }
  } catch {
    // Silently skip
  }

  return changes;
}

export async function scrapeCompany(company: {
  id: string;
  name: string;
  edgarCik?: string | null;
}): Promise<ScrapedChange[]> {
  const [edgarChanges, newsChanges, courtChanges] = await Promise.all([
    company.edgarCik ? scrapeEdgar(company.edgarCik, company.name) : Promise.resolve([]),
    scrapeGoogleNews(company.id, company.name),
    scrapeCourtListener(company.id, company.name),
  ]);
  return [...edgarChanges, ...newsChanges, ...courtChanges];
}

export async function scrapeAllSources(
  companies: { id: string; name: string; edgarCik: string | null }[],
): Promise<ScrapedChange[]> {
  const results = await Promise.all(companies.map((company) => scrapeCompany(company)));
  return results.flat();
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match?.[1]?.trim() ?? null;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}
