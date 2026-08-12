import { describe, it, expect } from 'vitest';
import { isDigestTimeForUser, getUserLocalHour } from './digest.js';

describe('Timezone-aware digest scheduler', () => {
  it('correctly calculates local hour in target timezone', () => {
    // 2026-08-01T12:00:00Z (12:00 UTC)
    const refDate = new Date('2026-08-01T12:00:00Z');

    // America/New_York (UTC-4 in EDT) -> 08:00 AM
    expect(getUserLocalHour('America/New_York', refDate)).toBe(8);

    // Europe/London (UTC+1 in BST) -> 13:00 (1 PM)
    expect(getUserLocalHour('Europe/London', refDate)).toBe(13);

    // Asia/Tokyo (UTC+9) -> 21:00 (9 PM)
    expect(getUserLocalHour('Asia/Tokyo', refDate)).toBe(21);
  });

  it('returns true when current local hour matches target digest hour (e.g. 8 AM)', () => {
    const refDate = new Date('2026-08-01T12:00:00Z'); // 8 AM EDT

    expect(isDigestTimeForUser('America/New_York', 8, refDate)).toBe(true);
    expect(isDigestTimeForUser('Europe/London', 8, refDate)).toBe(false);
  });

  it('defaults gracefully to UTC if invalid timezone is passed', () => {
    const refDate = new Date('2026-08-01T08:00:00Z');
    expect(isDigestTimeForUser('Invalid/Timezone', 8, refDate)).toBe(true);
  });
});
