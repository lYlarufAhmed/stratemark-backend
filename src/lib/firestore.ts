import { Firestore, type CollectionReference, type DocumentReference } from '@google-cloud/firestore';
import {
  USER_SCOPED_COLLECTIONS,
  getUserPath,
  getUserCollectionPath,
  getUserDocumentPath,
  type UserScopedCollectionName,
  type Market,
  type Deck,
  type Card,
  type CardWithCompany,
  type Company,
  type CompanyMetric,
  type ViceClaim,
} from '@mi/contracts';
import { config } from '../config.js';
import type { SentinelAlert, TrackedCompany, User } from '../types.js';

export const db = new Firestore({ projectId: config.gcp.projectId });

/** Legacy top-level collections (maintained for backwards compatibility) */
export const collections = {
  users: db.collection('users'),
  companies: db.collection('companies'),
  alerts: db.collection('alerts'),
} as const;

// ── Generic User-Scoped Firestore Helpers ─────────────────────────────────

/** Get a CollectionReference for a collection scoped under /users/{userId}/{collectionName} */
export function getUserScopedCollection(
  userId: string,
  collectionName: UserScopedCollectionName | string,
): CollectionReference {
  return db.collection(getUserCollectionPath(userId, collectionName));
}

/** Get a DocumentReference for a document scoped under /users/{userId}/{collectionName}/{docId} */
export function getUserScopedDocRef(
  userId: string,
  collectionName: UserScopedCollectionName | string,
  docId: string,
): DocumentReference {
  return db.doc(getUserDocumentPath(userId, collectionName, docId));
}

/** Read a document from /users/{userId}/{collectionName}/{docId} */
export async function readUserScopedDoc<T>(
  userId: string,
  collectionName: UserScopedCollectionName | string,
  docId: string,
): Promise<T | null> {
  const docRef = getUserScopedDocRef(userId, collectionName, docId);
  const snap = await docRef.get();
  return snap.exists ? (snap.data() as T) : null;
}

/** Write/Set a document at /users/{userId}/{collectionName}/{docId} */
export async function writeUserScopedDoc<T extends object>(
  userId: string,
  collectionName: UserScopedCollectionName | string,
  docId: string,
  data: T,
  merge = true,
): Promise<void> {
  const docRef = getUserScopedDocRef(userId, collectionName, docId);
  await docRef.set(data, { merge });
}

/** Delete a document at /users/{userId}/{collectionName}/{docId} */
export async function deleteUserScopedDoc(
  userId: string,
  collectionName: UserScopedCollectionName | string,
  docId: string,
): Promise<void> {
  const docRef = getUserScopedDocRef(userId, collectionName, docId);
  await docRef.delete();
}

/** List all documents in a user collection /users/{userId}/{collectionName} */
export async function listUserScopedDocs<T>(
  userId: string,
  collectionName: UserScopedCollectionName | string,
): Promise<T[]> {
  const colRef = getUserScopedCollection(userId, collectionName);
  const snap = await colRef.get();
  return snap.docs.map((doc) => doc.data() as T);
}

// ── User-Isolated Domain Helpers ───────────────────────────────────────────

// Markets
export async function getUserMarkets(userId: string): Promise<Market[]> {
  return listUserScopedDocs<Market>(userId, USER_SCOPED_COLLECTIONS.MARKETS);
}

export async function getUserMarket(userId: string, marketId: string): Promise<Market | null> {
  return readUserScopedDoc<Market>(userId, USER_SCOPED_COLLECTIONS.MARKETS, marketId);
}

export async function setUserMarket(userId: string, market: Market): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.MARKETS, market.id, market);
}

// Decks
export async function getUserDecks(userId: string): Promise<Deck[]> {
  return listUserScopedDocs<Deck>(userId, USER_SCOPED_COLLECTIONS.DECKS);
}

export async function getUserDeck(userId: string, deckId: string): Promise<Deck | null> {
  return readUserScopedDoc<Deck>(userId, USER_SCOPED_COLLECTIONS.DECKS, deckId);
}

export async function setUserDeck(userId: string, deck: Deck): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.DECKS, deck.id, deck);
}

// Cards
export async function getUserCards(userId: string): Promise<Card[]> {
  return listUserScopedDocs<Card>(userId, USER_SCOPED_COLLECTIONS.CARDS);
}

export async function getUserCard(userId: string, cardId: string): Promise<Card | null> {
  return readUserScopedDoc<Card>(userId, USER_SCOPED_COLLECTIONS.CARDS, cardId);
}

export async function setUserCard(userId: string, card: Card): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.CARDS, card.id, card);
}

// Companies
export async function getUserCompanies(userId: string): Promise<Company[]> {
  return listUserScopedDocs<Company>(userId, USER_SCOPED_COLLECTIONS.COMPANIES);
}

export async function getUserCompany(userId: string, companyId: string): Promise<Company | null> {
  return readUserScopedDoc<Company>(userId, USER_SCOPED_COLLECTIONS.COMPANIES, companyId);
}

export async function setUserCompany(userId: string, company: Company): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.COMPANIES, company.id, company);
}

// Metrics
export async function getUserMetrics(userId: string): Promise<CompanyMetric[]> {
  return listUserScopedDocs<CompanyMetric>(userId, USER_SCOPED_COLLECTIONS.METRICS);
}

export async function getUserMetric(userId: string, metricId: string): Promise<CompanyMetric | null> {
  return readUserScopedDoc<CompanyMetric>(userId, USER_SCOPED_COLLECTIONS.METRICS, metricId);
}

export async function setUserMetric(userId: string, metric: CompanyMetric): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.METRICS, metric.id, metric);
}

// Vice Claims
export async function getUserViceClaims(userId: string): Promise<ViceClaim[]> {
  return listUserScopedDocs<ViceClaim>(userId, USER_SCOPED_COLLECTIONS.VICE_CLAIMS);
}

export async function getUserViceClaim(
  userId: string,
  viceClaimId: string,
): Promise<ViceClaim | null> {
  return readUserScopedDoc<ViceClaim>(userId, USER_SCOPED_COLLECTIONS.VICE_CLAIMS, viceClaimId);
}

export async function setUserViceClaim(userId: string, viceClaim: ViceClaim): Promise<void> {
  await writeUserScopedDoc(userId, USER_SCOPED_COLLECTIONS.VICE_CLAIMS, viceClaim.id, viceClaim);
}

export async function persistCardWithCompany(userId: string, cwc: CardWithCompany): Promise<void> {
  await setUserCard(userId, cwc.card);
  if (cwc.company) {
    await setUserCompany(userId, cwc.company);
  }
  for (const metric of cwc.metrics) {
    await setUserMetric(userId, metric);
  }
  for (const viceClaim of cwc.viceClaims) {
    await setUserViceClaim(userId, viceClaim);
  }
}

// ── User Management & Sentinel Alerts ──────────────────────────────────────

export async function getUser(userId: string): Promise<User | null> {
  const doc = await db.doc(getUserPath(userId)).get();
  if (doc.exists) return doc.data() as User;
  const legacyDoc = await collections.users.doc(userId).get();
  return legacyDoc.exists ? (legacyDoc.data() as User) : null;
}

export async function createUser(user: User): Promise<void> {
  await db.doc(getUserPath(user.id)).set(user, { merge: true });
  await collections.users.doc(user.id).set(user, { merge: true });
}

export async function getCompaniesForUser(userId: string): Promise<TrackedCompany[]> {
  const userScoped = await listUserScopedDocs<TrackedCompany>(
    userId,
    USER_SCOPED_COLLECTIONS.COMPANIES,
  );
  if (userScoped.length > 0) return userScoped;
  const snap = await collections.companies.where('userId', '==', userId).get();
  return snap.docs.map((d) => d.data() as TrackedCompany);
}

export async function createCompany(company: TrackedCompany): Promise<void> {
  await writeUserScopedDoc(company.userId, USER_SCOPED_COLLECTIONS.COMPANIES, company.id, company);
  await collections.companies.doc(company.id).set(company);
}

export async function saveAlert(alert: SentinelAlert): Promise<void> {
  await writeUserScopedDoc(alert.userId, USER_SCOPED_COLLECTIONS.ALERTS, alert.id, alert);
  await collections.alerts.doc(alert.id).set(alert);
}

export async function getAlertsForUser(userId: string, limit = 50): Promise<SentinelAlert[]> {
  const colRef = getUserScopedCollection(userId, USER_SCOPED_COLLECTIONS.ALERTS);
  const snap = await colRef.orderBy('createdAt', 'desc').limit(limit).get();
  if (!snap.empty) return snap.docs.map((d) => d.data() as SentinelAlert);

  const legacySnap = await collections.alerts
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return legacySnap.docs.map((d) => d.data() as SentinelAlert);
}

export async function markAlertDelivered(alertId: string, userId?: string): Promise<void> {
  if (userId) {
    await getUserScopedDocRef(userId, USER_SCOPED_COLLECTIONS.ALERTS, alertId).update({
      deliveredAt: new Date().toISOString(),
    });
  }
  await collections.alerts.doc(alertId).update({ deliveredAt: new Date().toISOString() });
}

const FIRESTORE_BATCH_LIMIT = 400;

/** Import user brain snapshot into user-scoped Firestore collections in chunks of 500 */
export async function importUserBrainSnapshot(
  userId: string,
  snapshot: {
    markets?: Market[];
    decks?: Deck[];
    cards?: Card[];
    companies?: Company[];
    metrics?: CompanyMetric[];
    viceClaims?: ViceClaim[];
    reports?: unknown[];
    threads?: unknown[];
  },
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ importedCount: number }> {
  const collectionKeys = [
    { key: 'markets', col: USER_SCOPED_COLLECTIONS.MARKETS, items: snapshot.markets ?? [] },
    { key: 'decks', col: USER_SCOPED_COLLECTIONS.DECKS, items: snapshot.decks ?? [] },
    { key: 'cards', col: USER_SCOPED_COLLECTIONS.CARDS, items: snapshot.cards ?? [] },
    { key: 'companies', col: USER_SCOPED_COLLECTIONS.COMPANIES, items: snapshot.companies ?? [] },
    { key: 'metrics', col: USER_SCOPED_COLLECTIONS.METRICS, items: snapshot.metrics ?? [] },
    { key: 'viceClaims', col: USER_SCOPED_COLLECTIONS.VICE_CLAIMS, items: snapshot.viceClaims ?? [] },
    { key: 'reports', col: 'reports', items: snapshot.reports ?? [] },
    { key: 'threads', col: 'threads', items: snapshot.threads ?? [] },
  ];

  if (mode === 'replace') {
    for (const { col } of collectionKeys) {
      const colRef = getUserScopedCollection(userId, col);
      const snap = await colRef.get();
      if (!snap.empty) {
        let batch = db.batch();
        let count = 0;
        for (const doc of snap.docs) {
          batch.delete(doc.ref);
          count++;
          if (count % FIRESTORE_BATCH_LIMIT === 0) {
            await batch.commit();
            batch = db.batch();
          }
        }
        if (count % FIRESTORE_BATCH_LIMIT !== 0) {
          await batch.commit();
        }
      }
    }
  }

  let totalImported = 0;
  let batch = db.batch();
  let count = 0;

  for (const { col, items } of collectionKeys) {
    for (const item of items as (object & { id?: string })[]) {
      if (!item || !item.id) continue;
      const docRef = getUserScopedDocRef(userId, col, item.id);
      batch.set(docRef, item, { merge: true });
      count++;
      totalImported++;

      if (count % FIRESTORE_BATCH_LIMIT === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
  }

  if (count % FIRESTORE_BATCH_LIMIT !== 0) {
    await batch.commit();
  }

  return { importedCount: totalImported };
}
