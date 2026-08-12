import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendSlackWebhook, sendDiscordWebhook } from './webhook.js';
import type { SentinelAlert } from '../types.js';

describe('Webhook Notifications', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mockAlert: SentinelAlert = {
    id: 'alert-1',
    userId: 'user-1',
    companyId: 'comp-1',
    companyName: 'Acme Corp',
    changeType: 'regulatory',
    confidence: 'sourced-primary',
    sourceUrl: 'https://sec.gov/123',
    sourceTitle: 'SEC 8-K Filing',
    summary: 'Acme Corp settled litigation for $5M.',
    createdAt: '2026-08-01T10:00:00Z',
    deliveredAt: null,
  };

  it('posts formatted alert message to Slack webhook', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    } as unknown as Response);

    const success = await sendSlackWebhook('https://hooks.slack.com/services/test', mockAlert);

    expect(success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://hooks.slack.com/services/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('Acme Corp'),
    });
  });

  it('posts formatted alert message to Discord webhook', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    } as unknown as Response);

    const success = await sendDiscordWebhook('https://discord.com/api/webhooks/test', mockAlert);

    expect(success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://discord.com/api/webhooks/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('Acme Corp'),
    });
  });

  it('returns false if webhook request fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
    } as unknown as Response);

    const success = await sendSlackWebhook('https://hooks.slack.com/services/test', mockAlert);
    expect(success).toBe(false);
  });
});
