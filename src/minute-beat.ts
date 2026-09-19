/**
 * How long until the clock's own next minute.
 *
 * Every span the wall draws counts in whole minutes, so the minute boundary is the instant
 * their text changes and a beat of any other length redraws the same words.
 */
export function msUntilNextMinute(from: number): number {
  return 60_000 - (from % 60_000);
}
