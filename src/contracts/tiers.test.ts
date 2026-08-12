import { describe, expect, it } from 'vitest';
import {
  ARR_BANDS,
  EMPLOYEE_BANDS,
  MARKET_SHARE_BANDS,
  VALUE_BANDS,
  mapUsersRelative,
  mapValueToTier,
} from './tiers';

describe('mapValueToTier', () => {
  it('maps ARR boundaries to the correct tiers', () => {
    expect(mapValueToTier(ARR_BANDS, 0)).toBe(1); // pre-revenue
    expect(mapValueToTier(ARR_BANDS, 500_000)).toBe(2); // <$1M
    expect(mapValueToTier(ARR_BANDS, 1_000_000)).toBe(3); // exactly $1M -> tier 3 band start
    expect(mapValueToTier(ARR_BANDS, 4_999_999)).toBe(3);
    expect(mapValueToTier(ARR_BANDS, 30_000_000)).toBe(5);
    expect(mapValueToTier(ARR_BANDS, 250_000_000)).toBe(7);
    expect(mapValueToTier(ARR_BANDS, 5_000_000_000)).toBe(8); // billions
  });

  it('maps employee headcount bands', () => {
    expect(mapValueToTier(EMPLOYEE_BANDS, 3)).toBe(1);
    expect(mapValueToTier(EMPLOYEE_BANDS, 5)).toBe(2);
    expect(mapValueToTier(EMPLOYEE_BANDS, 150)).toBe(4);
    expect(mapValueToTier(EMPLOYEE_BANDS, 5_000)).toBe(7);
    expect(mapValueToTier(EMPLOYEE_BANDS, 60_000)).toBe(8);
  });

  it('maps valuation / market cap bands monotonically', () => {
    expect(mapValueToTier(VALUE_BANDS, 4_000_000)).toBe(1);
    expect(mapValueToTier(VALUE_BANDS, 500_000_000)).toBe(5);
    expect(mapValueToTier(VALUE_BANDS, 5_000_000_000)).toBe(6);
    expect(mapValueToTier(VALUE_BANDS, 25_000_000_000)).toBe(7);
    expect(mapValueToTier(VALUE_BANDS, 120_000_000_000)).toBe(8);
  });

  it('maps market-share percentages', () => {
    expect(mapValueToTier(MARKET_SHARE_BANDS, 0)).toBe(1);
    expect(mapValueToTier(MARKET_SHARE_BANDS, 0.2)).toBe(2);
    expect(mapValueToTier(MARKET_SHARE_BANDS, 3)).toBe(4);
    expect(mapValueToTier(MARKET_SHARE_BANDS, 12)).toBe(6);
    expect(mapValueToTier(MARKET_SHARE_BANDS, 55)).toBe(8);
  });

  it('rejects invalid input', () => {
    expect(mapValueToTier(ARR_BANDS, -1)).toBeNull();
    expect(mapValueToTier(ARR_BANDS, Number.NaN)).toBeNull();
  });
});

describe('mapUsersRelative', () => {
  const deck = [1_000, 10_000, 100_000, 1_000_000, 5_000_000];

  it('ranks the smallest to a low tier and the largest to a high tier', () => {
    expect(mapUsersRelative(1_000, deck)).toBe(1);
    expect(mapUsersRelative(5_000_000, deck)).toBe(8);
  });

  it('places mid values in the middle of the range', () => {
    const tier = mapUsersRelative(100_000, deck);
    expect(tier).not.toBeNull();
    expect(tier! >= 3 && tier! <= 6).toBe(true);
  });

  it('returns null when there is not enough context for a ranking', () => {
    expect(mapUsersRelative(1_000, [])).toBeNull();
    expect(mapUsersRelative(1_000, [1_000])).toBeNull();
    expect(mapUsersRelative(1_000, [5_000, 5_000, 5_000])).toBeNull(); // all identical
  });

  it('rejects invalid input', () => {
    expect(mapUsersRelative(-5, deck)).toBeNull();
  });
});
