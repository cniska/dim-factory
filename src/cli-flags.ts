type FlagFail = (message: string) => Error;

export type Parsed<Flag extends string> = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Partial<Record<Flag, string>>>;
};

export function parseArgs<Flag extends string>(
  args: readonly string[],
  spec: { readonly positionals: number; readonly flags: readonly Flag[] },
  fail: FlagFail,
): Parsed<Flag> {
  const positionals: string[] = [];
  const flags: Partial<Record<Flag, string>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const flag = spec.flags.find((known) => `--${known}` === arg);
    if (flag === undefined) throw fail(`does not take ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw fail(`${arg} needs a value`);
    if (flags[flag] !== undefined) throw fail(`takes ${arg} once`);
    flags[flag] = value;
    index += 1;
  }
  if (positionals.length !== spec.positionals) {
    throw fail(
      `takes ${spec.positionals} argument(s), and got ${positionals.length}: ${positionals.join(" ")}`,
    );
  }
  return { positionals, flags };
}

export function positionalArg(args: string[], valueFlags: string[], fail: FlagFail): string | undefined {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valueFlags.includes(arg)) index += 1;
    else if (arg.startsWith("--")) throw fail(`does not take ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length > 1)
    throw fail(`takes one argument, and got ${positionals.length}: ${positionals.join(" ")}`);
  return positionals[0];
}
