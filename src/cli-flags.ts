export type FlagFail = (message: string) => Error;

export function readFlags(args: string[], allowed: string[], fail: FlagFail): Map<string, string> {
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!allowed.includes(flag)) throw fail(`${flag} is not an option this takes`);
    if (value === undefined) throw fail(`${flag} needs a value`);
    if (value.startsWith("--")) throw fail(`${flag} needs a value that is not an option`);
    if (given.has(flag)) throw fail(`${flag} may be given once`);
    given.set(flag, value);
  }
  return given;
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

export function requiredFlag(given: Map<string, string>, flag: string, fail: FlagFail): string {
  const value = given.get(flag);
  if (value === undefined) throw fail(`${flag} is required`);
  return value;
}
