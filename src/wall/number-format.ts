function rung(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded < 100 ? rounded.toFixed(1) : String(Math.round(value));
}

export function formatCompactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const thousands = rung(n / 1000);
    return thousands === "1000" ? `${rung(n / 1_000_000)}M` : `${thousands}k`;
  }
  return `${rung(n / 1_000_000)}M`;
}
