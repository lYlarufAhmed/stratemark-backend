import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrapeCourtListener } from './courtlistener.js';

describe('scrapeCourtListener', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches dockets from CourtListener API and returns ScrapedChange array', async () => {
    const mockResponse = {
      count: 1,
      results: [
        {
          id: 12345,
          case_name: 'SEC v. Acme Corp',
          absolute_url: '/docket/12345/sec-v-acme-corp/',
          docket_number: '1:24-cv-00123',
          date_filed: '2026-08-01',
          summary: 'Civil enforcement action alleging securities violations.',
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as Response);

    const results = await scrapeCourtListener('acme-123', 'Acme Corp');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://www.courtlistener.com/api/rest/v3/dockets/?q=%22Acme%20Corp%22'),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      companyId: 'acme-123',
      companyName: 'Acme Corp',
      sourceUrl: 'https://www.courtlistener.com/docket/12345/sec-v-acme-corp/',
      sourceTitle: 'SEC v. Acme Corp',
      rawText: 'Civil enforcement action alleging securities violations.',
      discoveredAt: '2026-08-01',
    });
  });

  it('handles empty results or failed fetch gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
    } as unknown as Response);

    const results = await scrapeCourtListener('acme-123', 'Acme Corp');
    expect(results).toEqual([]);
  });
});
