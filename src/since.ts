/**
 * Resolve `--since` to the ISO timestamp the queries compare against. The
 * default exists because guidance, projects and habits all changed across the
 * corpus, so a count over all of history describes a machine that no longer
 * runs. It is a spend control on evidence, not a correctness rule: the constant
 * is arbitrary and `--all` turns it off.
 */
export const DEFAULT_WINDOW = "30d";

export class BadWindowError extends Error {
  readonly code = "BAD_WINDOW";
  constructor(readonly spec: string) {
    super(`--since ${spec} is neither <n>d nor YYYY-MM-DD`);
  }
}

export function resolveSince(spec: string, now: Date = new Date()): string {
  const days = /^(\d+)d$/.exec(spec);
  if (days) {
    const at = new Date(now.getTime() - Number(days[1]) * 86_400_000);
    return at.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    const at = new Date(`${spec}T00:00:00.000Z`);
    if (Number.isNaN(at.getTime())) throw new BadWindowError(spec);
    return at.toISOString();
  }
  throw new BadWindowError(spec);
}

/**
 * `--all` beats `--since`, so asking for all of history is never silently
 * narrowed by a default the caller forgot was there.
 */
export function windowFromArgs(
  args: string[],
  opts: { spansHistory?: boolean } = {},
  now: Date = new Date(),
): string | undefined {
  if (args.includes("--all")) return undefined;
  const flag = args.indexOf("--since");
  if (flag !== -1) {
    const spec = args[flag + 1];
    if (!spec || spec.startsWith("--")) throw new BadWindowError("(missing)");
    return resolveSince(spec, now);
  }
  return opts.spansHistory ? undefined : resolveSince(DEFAULT_WINDOW, now);
}
