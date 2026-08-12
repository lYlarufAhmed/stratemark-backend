export type AlertConfidence = 'sourced-primary' | 'reported-secondary' | 'unknown';

export type ChangeType =
  | 'regulatory'
  | 'funding'
  | 'hiring'
  | 'pricing'
  | 'product'
  | 'other';

export interface SentinelAlert {
  id: string;
  userId: string;
  companyId: string;
  companyName: string;
  changeType: ChangeType;
  confidence: AlertConfidence;
  sourceUrl: string | null;
  sourceTitle: string;
  summary: string;
  stateDeltaNote?: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface TrackedCompany {
  id: string;
  userId: string;
  name: string;
  edgarCik: string | null;
  newsSources: string[];
  rssFeeds: string[];
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  subscriptionTier: 'pro' | 'team' | 'enterprise';
  subscriptionStatus: 'active' | 'trialing' | 'canceled';
  stripeCustomerId: string | null;
  timezone?: string;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  createdAt: string;
}

export interface ScrapedChange {
  companyId: string;
  companyName: string;
  sourceUrl: string | null;
  sourceTitle: string;
  rawText: string;
  discoveredAt: string;
}

export interface ClassifiedChange extends ScrapedChange {
  changeType: ChangeType;
  confidence: number;
  summary: string;
  isDuplicate?: boolean;
  isStateUpdate?: boolean;
  stateDeltaNote?: string;
}
