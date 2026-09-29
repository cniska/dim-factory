import { UsageError } from "./cli-contract";
import type { QueryWindow } from "./query";

export const DEFAULT_WINDOW = "30d";

const badSince = (spec: string) => new UsageError(`--since ${spec} is neither <n>d nor YYYY-MM-DD`);

export function resolveSince(spec: string, now: Date = new Date()): string {
  const days = /^(\d+)d$/.exec(spec);
  if (days) {
    const at = new Date(now.getTime() - Number(days[1]) * 86_400_000);
    if (Number.isNaN(at.getTime())) throw badSince(spec);
    return at.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    const at = new Date(`${spec}T00:00:00.000Z`);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== spec) throw badSince(spec);
    return at.toISOString();
  }
  throw badSince(spec);
}

export function windowFromArgs(args: string[], window: QueryWindow, now: Date = new Date()): string | null {
  if (window === "none") {
    if (args.includes("--since") || args.includes("--all")) {
      throw new UsageError("this query reads no time window, so it takes neither --since nor --all");
    }
    return null;
  }
  if (args.includes("--all")) return null;
  const flag = args.indexOf("--since");
  if (flag !== -1) {
    const spec = args[flag + 1];
    if (!spec || spec.startsWith("--")) throw badSince("(missing)");
    return resolveSince(spec, now);
  }
  return window === "history" ? null : resolveSince(DEFAULT_WINDOW, now);
}
