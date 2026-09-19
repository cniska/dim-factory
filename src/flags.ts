export type FlagFail = (message: string) => Error;

/**
 * A flag given twice is refused rather than resolved to either value: a skill
 * assembles these from a shell line, and a title that silently lost half of
 * itself reads on the wall as an order nobody can match back to its item.
 */
export function readFlags(args: string[], allowed: string[], fail: FlagFail): Map<string, string> {
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!allowed.includes(flag)) throw fail(`${flag} is not an option this takes`);
    if (value === undefined) throw fail(`${flag} needs a value`);
    // A value that reads as a flag is refused rather than taken, so a missing
    // argument cannot quietly consume the next option as its own text.
    if (value.startsWith("--")) throw fail(`${flag} needs a value that is not an option`);
    if (given.has(flag)) throw fail(`${flag} may be given once`);
    given.set(flag, value);
  }
  return given;
}

export function requiredFlag(given: Map<string, string>, flag: string, fail: FlagFail): string {
  const value = given.get(flag);
  if (value === undefined) throw fail(`${flag} is required`);
  return value;
}
