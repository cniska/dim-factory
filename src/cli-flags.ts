type FlagFail = (message: string) => Error;

export type Parsed<Flag extends string, Switch extends string = never> = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Partial<Record<Flag, string>>>;
  readonly switches: ReadonlySet<Switch>;
};

export type ArgSpec<Flag extends string, Switch extends string = never> = {
  readonly positionals: readonly [min: number, max: number];
  readonly flags: readonly Flag[];
  readonly switches?: readonly Switch[];
};

export function parseArgs<Flag extends string, Switch extends string = never>(
  args: readonly string[],
  spec: ArgSpec<Flag, Switch>,
  fail: FlagFail,
): Parsed<Flag, Switch> {
  const positionals: string[] = [];
  const flags: Partial<Record<Flag, string>> = {};
  const switches = new Set<Switch>();
  const rest = [...args];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const switched = spec.switches?.find((known) => `--${known}` === arg);
    if (switched !== undefined) {
      if (switches.has(switched)) throw fail(`takes ${arg} once`);
      switches.add(switched);
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
  return { positionals, flags, switches };
}
