import { describe, it, expect } from 'vitest';
import { enforceAlertProvenance, enforceAlertsProvenance } from './provenance.js';
import type { ClassifiedChange } from './types.js';

function makeChange(overrides: Partial<ClassifiedChange> = {}): ClassifiedChange {
  return {
    companyId: 'company-1',
    companyName: 'Acme Corp',
    sourceUrl: 'https://sec.gov/filing/123',
    sourceTitle: 'SEC EDGAR',
    rawText: 'Test filing',
    discoveredAt: '2026-08-01T00:00:00Z',
    changeType: 'regulatory',
    confidence: 0.9,
    summary: 'Test summary',
    ...overrides,
  };
}

describe('enforceAlertProvenance', () => {
  it('marks SEC EDGAR URLs as sourced-primary', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: 'https://sec.gov/cgi-bin/browse-edgar?action=getcompany' }),
      'user-1',
    );
    expect(alert.confidence).toBe('sourced-primary');
  });

  it('marks PACER URLs as sourced-primary', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: 'https://pacer.uscourts.gov/case/123' }),
      'user-1',
    );
    expect(alert.confidence).toBe('sourced-primary');
  });

  it('marks news URLs as reported-secondary', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: 'https://techcrunch.com/2026/08/01/acme' }),
      'user-1',
    );
    expect(alert.confidence).toBe('reported-secondary');
  });

  it('demotes to unknown when no source URL', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: null }),
      'user-1',
    );
    expect(alert.confidence).toBe('unknown');
    expect(alert.sourceUrl).toBeNull();
  });

  it('demotes to unknown when source URL is empty string', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: '' }),
      'user-1',
    );
    expect(alert.confidence).toBe('unknown');
  });

  it('resolves publisher name via publisherOf', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: 'https://techcrunch.com/2026/08/01', sourceTitle: '' }),
      'user-1',
    );
    expect(alert.sourceTitle).toBe('techcrunch.com');
  });

  it('preserves human-readable publisher name', () => {
    const alert = enforceAlertProvenance(
      makeChange({ sourceUrl: 'https://sec.gov/filing', sourceTitle: 'SEC EDGAR' }),
      'user-1',
    );
    expect(alert.sourceTitle).toBe('SEC EDGAR');
  });

  it('sets correct userId', () => {
    const alert = enforceAlertProvenance(makeChange(), 'user-42');
    expect(alert.userId).toBe('user-42');
  });

  it('sets createdAt timestamp', () => {
    const before = Date.now();
    const alert = enforceAlertProvenance(makeChange(), 'user-1');
    const after = Date.now();
    const created = new Date(alert.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });

  it('sets deliveredAt to null', () => {
    const alert = enforceAlertProvenance(makeChange(), 'user-1');
    expect(alert.deliveredAt).toBeNull();
  });
});

describe('enforceAlertsProvenance', () => {
  it('processes multiple changes', () => {
    const changes = [
      makeChange({ sourceUrl: 'https://sec.gov/filing' }),
      makeChange({ sourceUrl: null }),
    ];
    const alerts = enforceAlertsProvenance(changes, 'user-1');
    expect(alerts).toHaveLength(2);
    expect(alerts[0].confidence).toBe('sourced-primary');
    expect(alerts[1].confidence).toBe('unknown');
  });
});
