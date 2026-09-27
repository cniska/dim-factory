export function msUntilNextMinute(from: number): number {
  return 60_000 - (from % 60_000);
}
