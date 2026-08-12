export function getUserLocalHour(timeZone: string, refDate = new Date()): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(refDate);
    const hourPart = parts.find((p) => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) % 24 : refDate.getUTCHours();
  } catch {
    return refDate.getUTCHours();
  }
}

export function isDigestTimeForUser(
  timeZone: string,
  targetHour = 8,
  refDate = new Date(),
): boolean {
  const localHour = getUserLocalHour(timeZone, refDate);
  return localHour === targetHour;
}
