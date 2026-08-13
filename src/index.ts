import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import {
  prepareDeckResearch,
  runDeckResearchFromStage1,
  createGeminiClient,
  type ResearchResult,
} from '@mi/research';
import { parseRepoSnapshot } from '@mi/contracts';
import { config } from './config.js';
import { scrapeAllSources, scrapeCompany } from './scrapers/index.js';
import { classifyChanges } from './classify/index.js';
import { enforceAlertsProvenance } from './provenance.js';
import {
  collections,
  getCompaniesForUser,
  saveAlert,
  markAlertDelivered,
  getUser,
  createUser,
  getAlertsForUser,
  getUserDecks,
  getUserDeck,
  getUserCards,
  getUserCompanies,
  getUserMetrics,
  getUserViceClaims,
  getUserMarkets,
  getUserMarket,
  setUserMarket,
  setUserDeck,
  setUserCard,
  setUserCompany,
  setUserMetric,
  setUserViceClaim,
  createCompany,
  importUserBrainSnapshot,
} from './lib/firestore.js';
import { sendBatchAlerts } from './lib/email.js';
import { sendSlackWebhook, sendDiscordWebhook } from './lib/webhook.js';
import { isDigestTimeForUser } from './lib/digest.js';
import {
  createCheckoutSession,
  createPortalSession,
  getStripe,
  PLANS,
  type PlanTier,
} from './lib/stripe.js';
import { authenticateToken, type AuthRequest } from './middleware/auth.js';
import type { TrackedCompany, User } from './types.js';

const app: express.Express = express();
app.use(cors());
app.use(express.json());

export function parseAuthHeader(req: express.Request): { userId: string | null; error?: string } {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { userId: null };
  if (!authHeader.startsWith('Bearer ') && authHeader !== 'Bearer') {
    return { userId: null, error: 'Invalid authorization header format' };
  }
  const token = authHeader.replace(/^Bearer\s*/, '').trim();
  if (!token) {
    return { userId: null, error: 'Empty token in authorization header' };
  }
  return { userId: token };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sentinel', timestamp: new Date().toISOString() });
});

// ── Auth: simple token-based login (email lookup) ───────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const snap = await collections.users.where('email', '==', email).get();
  if (snap.empty) {
    const userId = `user-${Date.now()}`;
    const isOmniveoPro = email ? email.endsWith('@omniveo.io') : false;
    const user: User = {
      id: userId,
      email,
      subscriptionTier: isOmniveoPro ? 'pro' : 'free',
      subscriptionStatus: isOmniveoPro ? 'active' : 'trialing',
      stripeCustomerId: null,
      createdAt: new Date().toISOString(),
    };
    await createUser(user);
    return res.json({ user });
  }
  res.json({ user: snap.docs[0].data() });
});
// -- Auth: return current user
app.get('/api/me', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const email = req.user?.email || null;

  let user = await getUser(userId);

  // Auto-provision user record if not exists
  if (!user) {
    const isOmniveoPro = email ? email.endsWith('@omniveo.io') : false;
    const newUser: User = {
      id: userId,
      email: email || `${userId}@user.stratemark.ai`,
      subscriptionTier: isOmniveoPro ? 'pro' : 'free',
      subscriptionStatus: isOmniveoPro ? 'active' : 'trialing',
      stripeCustomerId: null,
      createdAt: new Date().toISOString(),
    };
    await createUser(newUser);
    user = newUser;
  } else if (email && email.endsWith('@omniveo.io') && user.subscriptionTier !== 'pro') {
    // Whitelist upgrade for team accounts
    user.subscriptionTier = 'pro';
    user.subscriptionStatus = 'active';
    await createUser(user);
  }

  res.json({ user });
});

// ── Stripe Checkout ─────────────────────────────────────────────────────────
app.post('/api/checkout', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { tier } = req.body ?? {};
  if (!tier) return res.status(400).json({ error: 'tier required' });
  if (tier === 'free' || !PLANS[tier as PlanTier]) return res.status(400).json({ error: 'invalid tier' });

  let user = await getUser(userId);
  if (!user) {
    const userEmail = req.user?.email || `${userId}@user.stratemark.ai`;
    const isOmniveoPro = userEmail.endsWith('@omniveo.io');
    const newUser: User = {
      id: userId,
      email: userEmail,
      subscriptionTier: isOmniveoPro ? 'pro' : 'free',
      subscriptionStatus: isOmniveoPro ? 'active' : 'trialing',
      stripeCustomerId: null,
      createdAt: new Date().toISOString(),
    };
    await createUser(newUser);
    user = newUser;
  }

  const url = await createCheckoutSession(tier as PlanTier, user.email, userId);
  res.json({ url });
});

app.post('/api/portal', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const user = await getUser(userId);
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'no subscription' });

  const url = await createPortalSession(user.stripeCustomerId);
  res.json({ url });
});

// ── Companies ───────────────────────────────────────────────────────────────
app.post('/api/companies', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { name, edgarCik } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const company: TrackedCompany = {
    id: `company-${Date.now()}`,
    userId,
    name,
    edgarCik: edgarCik ?? null,
    newsSources: [],
    rssFeeds: [],
    createdAt: new Date().toISOString(),
  };
  await createCompany(company);
  res.json({ company });
});

app.get('/api/companies', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const companies = await getCompaniesForUser(userId);
  res.json({ companies });
});

// ── Alerts ──────────────────────────────────────────────────────────────────
app.get('/api/alerts', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const alerts = await getAlertsForUser(userId);
  res.json({ alerts });
});

// ── Scrape Trigger ──────────────────────────────────────────────────────────
app.post('/api/scrape', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    let totalAlerts = 0;

    // Process companies for the authenticated user
    const userCompanies = await getCompaniesForUser(userId);
    if (userCompanies.length > 0) {
      const existingAlerts = await getAlertsForUser(userId);
      const rawChanges = await scrapeAllSources(userCompanies);
      const classified = await classifyChanges(rawChanges, existingAlerts);
      const nonDuplicateClassified = classified.filter((c) => !c.isDuplicate);
      const alerts = enforceAlertsProvenance(nonDuplicateClassified, userId);

      const newAlerts = alerts.filter((a) => a.confidence !== 'unknown');
      for (const alert of newAlerts) {
        await saveAlert(alert);
      }

      if (newAlerts.length > 0) {
        const user = await getUser(userId);
        if (user) {
          for (const alert of newAlerts) {
            if (user.slackWebhookUrl) await sendSlackWebhook(user.slackWebhookUrl, alert);
            if (user.discordWebhookUrl) await sendDiscordWebhook(user.discordWebhookUrl, alert);
          }
          if (user.email && isDigestTimeForUser(user.timezone ?? 'UTC')) {
            const sent = await sendBatchAlerts(newAlerts, user.email);
            for (const alert of newAlerts) {
              if (sent > 0) await markAlertDelivered(alert.id, userId);
            }
            totalAlerts += sent;
          }
        }
      }
    }

    // Process other active subscribers
    const usersSnap = await collections.users
      .where('subscriptionStatus', 'in', ['active', 'trialing'])
      .get();

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data() as User;
      if (user.id === userId) continue;

      const companies = await getCompaniesForUser(user.id);
      if (companies.length === 0) continue;

      const existingAlerts = await getAlertsForUser(user.id);
      const rawChanges = await scrapeAllSources(companies);
      const classified = await classifyChanges(rawChanges, existingAlerts);
      const nonDuplicateClassified = classified.filter((c) => !c.isDuplicate);
      const alerts = enforceAlertsProvenance(nonDuplicateClassified, user.id);

      const newAlerts = alerts.filter((a) => a.confidence !== 'unknown');
      for (const alert of newAlerts) {
        await saveAlert(alert);
      }

      if (newAlerts.length > 0) {
        for (const alert of newAlerts) {
          if (user.slackWebhookUrl) await sendSlackWebhook(user.slackWebhookUrl, alert);
          if (user.discordWebhookUrl) await sendDiscordWebhook(user.discordWebhookUrl, alert);
        }
        if (user.email && isDigestTimeForUser(user.timezone ?? 'UTC')) {
          const sent = await sendBatchAlerts(newAlerts, user.email);
          for (const alert of newAlerts) {
            if (sent > 0) await markAlertDelivered(alert.id, user.id);
          }
          totalAlerts += sent;
        }
      }
    }

    res.json({ ok: true, alertsSent: totalAlerts });
  } catch (err) {
    console.error('Scrape failed:', err);
    res.status(500).json({ ok: false, error: 'Scrape failed' });
  }
});

// ── Deck Research & Scrape Pipeline ─────────────────────────────────────────
async function persistResearchResult(userId: string, result: ResearchResult): Promise<void> {
  await setUserMarket(userId, result.market);
  await setUserDeck(userId, result.deck);
  const savedCompanies = new Set<string>();
  for (const cardWithCompany of result.cards) {
    await setUserCard(userId, cardWithCompany.card);
    if (cardWithCompany.company && !savedCompanies.has(cardWithCompany.company.id)) {
      savedCompanies.add(cardWithCompany.company.id);
      await setUserCompany(userId, cardWithCompany.company);
    }
    for (const metric of cardWithCompany.metrics) await setUserMetric(userId, metric);
    for (const viceClaim of cardWithCompany.viceClaims) await setUserViceClaim(userId, viceClaim);
  }
}

async function scrapeDiscoveredCompanies(userId: string, result: ResearchResult): Promise<void> {
  const companies = new Map<string, { id: string; name: string; edgarCik?: string | null }>();
  for (const cardWithCompany of result.cards) {
    if (!cardWithCompany.company || companies.has(cardWithCompany.company.id)) continue;
    companies.set(cardWithCompany.company.id, {
      id: cardWithCompany.company.id,
      name: cardWithCompany.company.name,
      edgarCik:
        (cardWithCompany.company as unknown as { edgarCik?: string | null }).edgarCik ?? null,
    });
  }
  await Promise.all(
    Array.from(companies.values()).map(async (company) => {
      const changes = await scrapeCompany(company);
      if (changes.length === 0) return;
      const alerts = enforceAlertsProvenance(await classifyChanges(changes), userId).filter(
        (alert) => alert.confidence !== 'unknown',
      );
      for (const alert of alerts) await saveAlert(alert);
    }),
  );
}

app.post('/api/research/deck', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { prompt, region = null, targetCompanies } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured' });
  }

  try {
    const client = createGeminiClient({
      apiKey,
      model: config.gemini.model,
    });
    const options = {
      apiKey,
      ...(targetCompanies ? { targetCompanies: Number(targetCompanies) } : {}),
    };

    const stage = await prepareDeckResearch({ prompt, region }, client, options);
    await Promise.all([
      setUserMarket(userId, stage.market),
      setUserDeck(userId, stage.deck),
      ...stage.cards.map((card) => setUserCard(userId, card)),
      ...stage.companies.map((company) => setUserCompany(userId, company)),
    ]);

    res.status(202).json({
      ok: true,
      stage: 'discovered',
      marketPlan: stage.plan,
      market: stage.market,
      deck: stage.deck,
      candidates: stage.candidates,
      cards: stage.cards,
      companies: stage.companies,
    });

    void runDeckResearchFromStage1(stage, client, options)
      .then(async (result) => {
        await persistResearchResult(userId, result);
        await scrapeDiscoveredCompanies(userId, result);
      })
      .catch((err: unknown) => {
        console.error(`Background deck enrichment failed for ${stage.deck.id}:`, err);
      });
  } catch (err) {
    console.error('Deck research failed:', err);
    res.status(500).json({
      error: 'Deck research failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Deck & Card Query Endpoints ──────────────────────────────────────────────
app.get('/api/decks', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const decks = await getUserDecks(userId);
  res.json({ decks });
});

app.get('/api/decks/:deckId', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { deckId } = req.params;
  const deck = await getUserDeck(userId, deckId);
  if (!deck) return res.status(404).json({ error: 'deck not found' });

  const [market, allCards, allCompanies, allMetrics, allViceClaims] = await Promise.all([
    getUserMarket(userId, deck.marketId),
    getUserCards(userId),
    getUserCompanies(userId),
    getUserMetrics(userId),
    getUserViceClaims(userId),
  ]);

  const cards = allCards.filter((c) => c.deckId === deckId);
  const companyIds = new Set(cards.map((c) => c.companyId).filter((id): id is string => Boolean(id)));
  const companies = allCompanies.filter((c) => companyIds.has(c.id));
  const metrics = allMetrics.filter((m) => companyIds.has(m.companyId));
  const cardIds = new Set(cards.map((c) => c.id));
  const viceClaims = allViceClaims.filter((vc) => cardIds.has(vc.cardId));

  res.json({
    deck,
    market,
    cards,
    companies,
    metrics,
    viceClaims,
  });
});

app.get('/api/cards', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { deckId } = req.query;
  const allCards = await getUserCards(userId);
  const cards = deckId ? allCards.filter((c) => c.deckId === String(deckId)) : allCards;
  res.json({ cards });
});

// ── Stripe Webhook ──────────────────────────────────────────────────────────
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'missing signature' });

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
  } catch {
    return res.status(400).json({ error: 'invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, tier } = session.metadata ?? {};
    if (userId && tier) {
      await collections.users.doc(userId).update({
        subscriptionTier: tier,
        subscriptionStatus: 'active',
        stripeCustomerId: session.customer as string,
      });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const snap = await collections.users.where('stripeCustomerId', '==', sub.customer).get();
    for (const doc of snap.docs) {
      await doc.ref.update({ subscriptionStatus: 'canceled' });
    }
  }

  res.json({ received: true });
});

// ── Paddle Webhook ───────────────────────────────────────────────────────────
app.post('/api/webhook/paddle', express.json(), async (req, res) => {
  try {
    const payload = req.body ?? {};
    const alertName = payload.alert_name || payload.event_type;

    let customData: { userId?: string; tier?: string } = {};
    if (payload.passthrough) {
      try {
        customData =
          typeof payload.passthrough === 'string'
            ? JSON.parse(payload.passthrough)
            : payload.passthrough;
      } catch { }
    } else if (payload.data?.custom_data) {
      customData = payload.data.custom_data;
    }

    const userId = customData.userId || payload.email || payload.data?.user_id;
    const tier = customData.tier || 'pro';

    if (userId) {
      await collections.users.doc(userId).set(
        {
          subscriptionTier: tier,
          subscriptionStatus: 'active',
          paymentProvider: 'paddle',
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    }

    res.json({ received: true, alertName, userId });
  } catch (err) {
    console.error('Paddle webhook error:', err);
    res.status(500).json({ error: 'Paddle webhook processing failed' });
  }
});

// ── Cloud Brain Import Endpoint ──────────────────────────────────────────────
app.post('/api/v1/brain/import', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.user?.uid;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: missing authenticated user' });
  }

  const { snapshot: rawSnapshot, mode = 'merge' } = req.body ?? {};
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    return res.status(400).json({ error: 'Invalid payload: snapshot object required' });
  }

  const { snapshot, totalItems, validItems, skippedItems, warnings } =
    parseRepoSnapshot(rawSnapshot);

  if (validItems === 0 && totalItems > 0) {
    return res.status(400).json({
      error: 'Import failed: all items in snapshot failed validation',
      warnings,
    });
  }

  try {
    const { importedCount } = await importUserBrainSnapshot(
      userId,
      snapshot,
      mode === 'replace' ? 'replace' : 'merge',
    );

    res.json({
      status: 'ok',
      mode,
      importedCount,
      totalItems,
      validItems,
      skippedItems,
      warnings,
    });
  } catch (err) {
    console.error('Failed to import user brain snapshot:', err);
    res.status(500).json({ error: 'Failed to import user brain snapshot to cloud storage' });
  }
});

export { app };

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const port = parseInt(process.env.PORT ?? '8080', 10);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Sentinel running on port ${port}`);
  });
}
