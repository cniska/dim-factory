type FlagFail = (message: string) => Error;

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
