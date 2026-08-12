import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyChange } from './index.js';
import type { ScrapedChange, SentinelAlert } from '../types.js';

describe('classifyChange with 30-day semantic deduplication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const scrapedChange: ScrapedChange = {
    companyId: 'comp-1',
    companyName: 'Acme Corp',
    sourceUrl: 'https://news.example.com/sec-probe',
    sourceTitle: 'SEC Probe into Acme Corp',
    rawText: 'SEC opens investigation into accounting practices.',
    discoveredAt: '2026-08-01T10:00:00Z',
  };

  it('classifies a new change with high confidence when no previous alerts exist', async () => {
    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  changeType: 'regulatory',
                  confidence: 0.9,
                  summary: 'SEC opens investigation into Acme Corp.',
                  isDuplicate: false,
                  isStateUpdate: false,
                }),
              },
            ],
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockGeminiResponse),
    } as unknown as Response);

    const result = await classifyChange(scrapedChange);

    expect(result.changeType).toBe('regulatory');
    expect(result.confidence).toBe(0.9);
    expect(result.isDuplicate).toBe(false);
  });

  it('detects duplicate events and flags isDuplicate: true', async () => {
    const previousAlerts: SentinelAlert[] = [
      {
        id: 'alert-1',
        userId: 'user-1',
        companyId: 'comp-1',
        companyName: 'Acme Corp',
        changeType: 'regulatory',
        confidence: 'sourced-primary',
        sourceUrl: 'https://sec.gov/123',
        sourceTitle: 'SEC SEC Probe',
        summary: 'SEC opens investigation into Acme Corp.',
        createdAt: '2026-07-30T08:00:00Z',
        deliveredAt: '2026-07-30T08:00:00Z',
      },
    ];

    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  changeType: 'regulatory',
                  confidence: 0.1,
                  summary: 'Re-hashed news on SEC investigation.',
                  isDuplicate: true,
                  isStateUpdate: false,
                }),
              },
            ],
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockGeminiResponse),
    } as unknown as Response);

    const result = await classifyChange(scrapedChange, previousAlerts);

    expect(result.isDuplicate).toBe(true);
    expect(result.confidence).toBe(0.1);
  });

  it('detects material state update and flags isStateUpdate: true', async () => {
    const previousAlerts: SentinelAlert[] = [
      {
        id: 'alert-1',
        userId: 'user-1',
        companyId: 'comp-1',
        companyName: 'Acme Corp',
        changeType: 'regulatory',
        confidence: 'sourced-primary',
        sourceUrl: 'https://sec.gov/123',
        sourceTitle: 'SEC SEC Probe',
        summary: 'SEC opens investigation into Acme Corp.',
        createdAt: '2026-07-30T08:00:00Z',
        deliveredAt: '2026-07-30T08:00:00Z',
      },
    ];

    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  changeType: 'regulatory',
                  confidence: 0.95,
                  summary: 'SEC settles investigation with Acme Corp for $10M fine.',
                  isDuplicate: false,
                  isStateUpdate: true,
                  stateDeltaNote: 'Settlement reached with $10M penalty.',
                }),
              },
            ],
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockGeminiResponse),
    } as unknown as Response);

    const result = await classifyChange(scrapedChange, previousAlerts);

    expect(result.isStateUpdate).toBe(true);
    expect(result.stateDeltaNote).toBe('Settlement reached with $10M penalty.');
  });
});
