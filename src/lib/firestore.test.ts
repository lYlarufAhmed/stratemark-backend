import { describe, expect, it } from 'vitest';
import {
  getUserCollectionPath,
  getUserDocumentPath,
  getUserMarketPath,
  getUserDeckPath,
  getUserCardPath,
  getUserCompanyPath,
  getUserMetricPath,
  getUserViceClaimPath,
} from '@mi/contracts';

describe('Sentinel firestore path isolation helpers', () => {
  const userId = 'usr_sentinel_1';

  it('generates user-scoped collection paths', () => {
    expect(getUserCollectionPath(userId, 'markets')).toBe('users/usr_sentinel_1/markets');
    expect(getUserCollectionPath(userId, 'decks')).toBe('users/usr_sentinel_1/decks');
    expect(getUserCollectionPath(userId, 'cards')).toBe('users/usr_sentinel_1/cards');
    expect(getUserCollectionPath(userId, 'companies')).toBe('users/usr_sentinel_1/companies');
    expect(getUserCollectionPath(userId, 'metrics')).toBe('users/usr_sentinel_1/metrics');
    expect(getUserCollectionPath(userId, 'viceClaims')).toBe('users/usr_sentinel_1/viceClaims');
  });

  it('generates user-scoped document paths for all core entities', () => {
    expect(getUserDocumentPath(userId, 'markets', 'm1')).toBe('users/usr_sentinel_1/markets/m1');
    expect(getUserMarketPath(userId, 'm1')).toBe('users/usr_sentinel_1/markets/m1');
    expect(getUserDeckPath(userId, 'd1')).toBe('users/usr_sentinel_1/decks/d1');
    expect(getUserCardPath(userId, 'c1')).toBe('users/usr_sentinel_1/cards/c1');
    expect(getUserCompanyPath(userId, 'comp1')).toBe('users/usr_sentinel_1/companies/comp1');
    expect(getUserMetricPath(userId, 'met1')).toBe('users/usr_sentinel_1/metrics/met1');
    expect(getUserViceClaimPath(userId, 'vc1')).toBe('users/usr_sentinel_1/viceClaims/vc1');
  });
});
