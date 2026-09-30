type FlagFail = (message: string) => Error;

export type Parsed<Flag extends string> = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Partial<Record<Flag, string>>>;
};

export type ArgSpec<Flag extends string> = {
  readonly positionals: readonly [min: number, max: number];
  readonly flags: readonly Flag[];
};

export function parseArgs<Flag extends string>(
  args: readonly string[],
  spec: ArgSpec<Flag>,
  fail: FlagFail,
): Parsed<Flag> {
  const positionals: string[] = [];
  const flags: Partial<Record<Flag, string>> = {};
  const rest = [...args];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const flag = spec.flags.find((known) => `--${known}` === arg);
    if (flag === undefined) throw fail(`does not take ${arg}`);
    const value = rest.shift();
    if (value === undefined || value.startsWith("--")) throw fail(`${arg} needs a value`);
    if (flags[flag] !== undefined) throw fail(`takes ${arg} once`);
    flags[flag] = value;
  }
  const [min, max] = spec.positionals;
  if (positionals.length < min || positionals.length > max) {
    const wanted = min === max ? `${min}` : `${min} to ${max}`;
    throw fail(`takes ${wanted} argument(s), and got ${positionals.length}: ${positionals.join(" ")}`);
  }
  return { positionals, flags };
}
