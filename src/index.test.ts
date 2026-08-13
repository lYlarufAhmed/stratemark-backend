import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const inMemoryDb = new Map<string, any>();

vi.mock('@google-cloud/firestore', () => {
  class MockFirestore {
    doc(docPath: string) {
      return {
        get: async () => ({
          exists: inMemoryDb.has(docPath),
          data: () => inMemoryDb.get(docPath),
        }),
        set: async (data: any, options?: any) => {
          if (options?.merge && inMemoryDb.has(docPath)) {
            inMemoryDb.set(docPath, { ...inMemoryDb.get(docPath), ...data });
          } else {
            inMemoryDb.set(docPath, data);
          }
        },
        update: async (data: any) => {
          const current = inMemoryDb.get(docPath) || {};
          inMemoryDb.set(docPath, { ...current, ...data });
        },
        delete: async () => {
          inMemoryDb.delete(docPath);
        },
      };
    }
    collection(colPath: string) {
      const getDocs = () => {
        const matching: Array<{ id: string; ref: any; data: () => any }> = [];
        for (const [path, data] of inMemoryDb.entries()) {
          const parent = path.substring(0, path.lastIndexOf('/'));
          const id = path.substring(path.lastIndexOf('/') + 1);
          if (parent === colPath) {
            matching.push({
              id,
              ref: this.doc(path),
              data: () => data,
            });
          }
        }
        return matching;
      };

      const queryObj: any = {
        where: () => queryObj,
        orderBy: () => queryObj,
        limit: () => queryObj,
        get: async () => {
          const docs = getDocs();
          return { empty: docs.length === 0, docs };
        },
      };

      return {
        ...queryObj,
        doc: (docId: string) => this.doc(`${colPath}/${docId}`),
      };
    }
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        set: (docRef: any, data: any, options?: any) => {
          ops.push(() => docRef.set(data, options));
        },
        delete: (docRef: any) => {
          ops.push(() => docRef.delete());
        },
        update: (docRef: any, data: any) => {
          ops.push(() => docRef.update(data));
        },
        commit: async () => {
          for (const op of ops) {
            await op();
          }
        },
      };
    }
  }

  return {
    Firestore: MockFirestore,
  };
});

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  getApps: vi.fn().mockReturnValue([{}]),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn().mockReturnValue({
    verifyIdToken: vi.fn().mockImplementation(async (token: string) => {
      if (token === 'invalid_token') {
        throw new Error('Invalid token');
      }
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (payload.uid) return { uid: payload.uid, email: payload.email };
        }
      } catch {}
      return { uid: token, email: `${token}@stratemark.ai` };
    }),
  }),
}));

vi.mock('@mi/research', () => ({
  createGeminiClient: vi.fn().mockReturnValue({}),
  prepareDeckResearch: vi.fn().mockImplementation(async (input) => ({
    plan: {
      marketName: 'Competitive Intel',
      vertical: 'AI',
      geography: input.region ?? 'Global',
      notes: null,
      searchThemes: ['startups'],
    },
    market: {
      id: 'mkt_1',
      name: 'Competitive Intel',
      scopeDefinition: { include: [], exclude: [], geography: input.region ?? 'Global' },
      refreshCadence: 'weekly',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    deck: {
      id: 'deck_1',
      marketId: 'mkt_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastRefreshedAt: null,
    },
    candidates: Array.from({ length: 10 }, (_, i) => ({
      name: `Candidate ${i + 1}`,
      domain: `candidate-${i + 1}.com`,
      descriptor: 'AI company',
      cardTypes: ['company'],
    })),
    cards: [
      {
        id: 'card_1',
        deckId: 'deck_1',
        companyId: 'comp_1',
        cardType: 'company',
        title: 'Card 1',
        summary: 'Summary 1',
        tier: null,
        tierReason: null,
        citations: [],
        keyPoints: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    companies: [
      {
        id: 'comp_1',
        name: 'Target Corp',
        oneLiner: 'Target Corp AI company',
        logoUrl: null,
        hqLocation: null,
        websiteUrl: 'https://target.com',
        brandTheme: null,
      },
    ],
  })),
  runDeckResearchFromStage1: vi.fn().mockImplementation(async (stage) => ({
    market: {
      ...stage.market,
    },
    deck: {
      ...stage.deck,
    },
    cards: [
      {
        card: {
          id: 'card_1',
          deckId: 'deck_1',
          cardType: 'company',
          title: 'Card 1',
          summary: 'Summary 1',
          confidence: 'sourced-primary',
          citations: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        company: {
          id: 'comp_1',
          name: 'Target Corp',
          rootDomain: 'target.com',
          ticker: 'TGT',
          logoUrl: null,
          brandTheme: {
            primary: '#000',
            secondary: '#fff',
            accent: '#f00',
            text: '#000',
            background: '#fff',
            fontFamily: null,
            source: 'default',
          },
          discoveredAt: '2026-01-01T00:00:00.000Z',
        },
        metrics: [
          {
            id: 'metric_1',
            companyId: 'comp_1',
            metricName: 'ARR',
            value: '$10M',
            period: '2025',
            confidence: 'sourced-primary',
            citations: [],
          },
        ],
        viceClaims: [
          {
            id: 'vc_1',
            cardId: 'card_1',
            claimText: 'High concentration risk',
            sourceUrl: 'https://example.com',
            sourceTitle: 'Filing',
            capturedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  })),
}));

vi.mock('./scrapers/index.js', () => ({
  scrapeAllSources: vi.fn().mockResolvedValue([]),
  scrapeCompany: vi.fn().mockResolvedValue([]),
}));

vi.mock('./classify/index.js', () => ({
  classifyChanges: vi.fn().mockResolvedValue([]),
}));

import { app } from './index.js';
import {
  getUserMarket,
  getUserDeck,
  getUserCard,
  getUserCompany,
  getUserMetric,
  getUserViceClaim,
} from './lib/firestore.js';

function makeToken(uid: string, email = `${uid}@stratemark.ai`): string {
  const payload = Buffer.from(JSON.stringify({ uid, email })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('Sentinel API Authentication & Persistence', () => {
  beforeEach(() => {
    inMemoryDb.clear();
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
  });

  describe('Authorization token enforcement', () => {
    it('returns 401 on /api/companies when Authorization header is missing', async () => {
      const res = await request(app).get('/api/companies');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/alerts when Authorization header is missing', async () => {
      const res = await request(app).get('/api/alerts');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/research/deck when Authorization header is missing', async () => {
      const res = await request(app).post('/api/research/deck').send({ prompt: 'test' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/checkout when Authorization header is missing', async () => {
      const res = await request(app).post('/api/checkout').send({ tier: 'pro' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/portal when Authorization header is missing', async () => {
      const res = await request(app).post('/api/portal').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/scrape when Authorization header is missing', async () => {
      const res = await request(app).post('/api/scrape').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('returns 401 on /api/me when Authorization header is missing', async () => {
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });
  });

  describe('/api/me & Subscription Tiers', () => {
    it('auto-provisions user with free subscription tier for regular users', async () => {
      const token = makeToken('usr_regular_1', 'user@example.com');
      const res = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe('user@example.com');
      expect(res.body.user.subscriptionTier).toBe('free');
      expect(res.body.user.subscriptionStatus).toBe('trialing');
    });

    it('auto-provisions user with pro subscription tier for omniveo.io whitelist emails', async () => {
      const token = makeToken('usr_omniveo_1', 'alice@omniveo.io');
      const res = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe('alice@omniveo.io');
      expect(res.body.user.subscriptionTier).toBe('pro');
      expect(res.body.user.subscriptionStatus).toBe('active');
    });

    it('upgrades existing non-pro user to pro when accessing /api/me with omniveo.io email', async () => {
      const token = makeToken('usr_omniveo_2', 'bob@omniveo.io');
      // Create user first as free
      await request(app).post('/api/auth/login').send({ email: 'bob@example.com' });

      const res = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.subscriptionTier).toBe('pro');
      expect(res.body.user.subscriptionStatus).toBe('active');
    });

    it('provisions free tier on login for standard emails', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'newuser@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.user.subscriptionTier).toBe('free');
    });

    it('rejects free tier checkout request on /api/checkout', async () => {
      const token = makeToken('usr_checkout_test');
      const res = await request(app)
        .post('/api/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'free' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid tier');
    });
  });

  describe('Companies Endpoint & User Isolation', () => {
    it('creates and fetches companies using verified uid from Bearer token', async () => {
      const token = makeToken('usr_sentinel_1');

      const createRes = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme Corp', edgarCik: '0000012345' });

      expect(createRes.status).toBe(200);
      expect(createRes.body.company.userId).toBe('usr_sentinel_1');
      expect(createRes.body.company.name).toBe('Acme Corp');

      const getRes = await request(app)
        .get('/api/companies')
        .set('Authorization', `Bearer ${token}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.companies).toHaveLength(1);
      expect(getRes.body.companies[0].name).toBe('Acme Corp');
    });

    it('ignores caller-supplied userId in body and forces verified uid', async () => {
      const token = makeToken('verified_usr_100');

      const createRes = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: 'spoofed_user_999', name: 'Spoof Test' });

      expect(createRes.status).toBe(200);
      expect(createRes.body.company.userId).toBe('verified_usr_100');
    });
  });

  describe('POST /api/research/deck Persistence & Instant Skeleton Cards', () => {
    it('persists market, deck, cards, companies, metrics, viceClaims and returns cards and companies stubs', async () => {
      const userId = 'usr_research_101';
      const token = makeToken(userId);

      const res = await request(app)
        .post('/api/research/deck')
        .set('Authorization', `Bearer ${token}`)
        .send({ prompt: 'Market research on AI startups', region: 'North America' });

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.stage).toBe('discovered');
      expect(res.body.candidates).toHaveLength(10);
      expect(res.body.cards).toBeDefined();
      expect(res.body.companies).toBeDefined();

      // Query deck endpoint
      const decksRes = await request(app)
        .get('/api/decks')
        .set('Authorization', `Bearer ${token}`);
      expect(decksRes.status).toBe(200);
      expect(decksRes.body.decks).toHaveLength(1);
      expect(decksRes.body.decks[0].name).toBe('Competitive Intel');

      // Query single deck endpoint with cards and companies
      const singleDeckRes = await request(app)
        .get(`/api/decks/${res.body.deck.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(singleDeckRes.status).toBe(200);
      expect(singleDeckRes.body.deck.id).toBe(res.body.deck.id);
      expect(singleDeckRes.body.deck.name).toBe('Competitive Intel');
      expect(singleDeckRes.body.cards.length).toBeGreaterThan(0);
      expect(singleDeckRes.body.companies.length).toBeGreaterThan(0);

      // Query cards endpoint
      const cardsRes = await request(app)
        .get('/api/cards')
        .set('Authorization', `Bearer ${token}`);
      expect(cardsRes.status).toBe(200);
      expect(cardsRes.body.cards.length).toBeGreaterThan(0);

      // Delete deck endpoint
      const deleteRes = await request(app)
        .delete(`/api/decks/${res.body.deck.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Verify deck is deleted
      const deletedCheckRes = await request(app)
        .get(`/api/decks/${res.body.deck.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deletedCheckRes.status).toBe(404);
    });
  });

  describe('POST /api/v1/brain/import Cloud Brain Import', () => {
    it('requires auth token', async () => {
      const res = await request(app).post('/api/v1/brain/import').send({ snapshot: {} });
      expect(res.status).toBe(401);
    });

    it('imports a valid user brain snapshot into user-scoped Firestore path', async () => {
      const snapshot = {
        markets: [
          {
            id: 'mkt_import_1',
            name: 'Imported Market',
            scopeDefinition: { vertical: 'Fintech', geography: null, notes: null },
            refreshCadence: 'weekly',
            createdAt: '2026-08-01T00:00:00Z',
          },
        ],
        decks: [
          {
            id: 'deck_import_1',
            marketId: 'mkt_import_1',
            createdAt: '2026-08-01T00:00:00Z',
            lastRefreshedAt: '2026-08-01T00:00:00Z',
          },
        ],
      };

      const res = await request(app)
        .post('/api/v1/brain/import')
        .set('Authorization', 'Bearer usr_brain_import_1')
        .send({ snapshot, mode: 'merge' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.importedCount).toBe(2);
      expect(res.body.totalItems).toBe(2);
      expect(res.body.validItems).toBe(2);
      expect(res.body.skippedItems).toBe(0);
    });

    it('tolerantly filters invalid snapshot items and returns warnings', async () => {
      const snapshot = {
        markets: [
          {
            id: 'mkt_valid_1',
            name: 'Valid Market',
            scopeDefinition: { vertical: 'AI', geography: null, notes: null },
            refreshCadence: 'weekly',
            createdAt: '2026-08-01T00:00:00Z',
          },
          { invalidMarket: true },
        ],
      };

      const res = await request(app)
        .post('/api/v1/brain/import')
        .set('Authorization', 'Bearer usr_brain_import_2')
        .send({ snapshot, mode: 'merge' });

      expect(res.status).toBe(200);
      expect(res.body.importedCount).toBe(1);
      expect(res.body.totalItems).toBe(2);
      expect(res.body.validItems).toBe(1);
      expect(res.body.skippedItems).toBe(1);
      expect(res.body.warnings).toContain("Skipped 1 invalid item(s) in 'markets'.");
    });
  });

  describe('Paddle Webhook Processing', () => {
    it('handles paddle webhook payload and updates user subscription tier to pro', async () => {
      const res = await request(app)
        .post('/api/webhook/paddle')
        .send({
          event_type: 'transaction.completed',
          passthrough: JSON.stringify({ userId: 'usr_paddle_123', tier: 'pro' }),
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.userId).toBe('usr_paddle_123');
    });
  });
});
