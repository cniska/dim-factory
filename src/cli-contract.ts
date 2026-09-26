export type Command = {
  name: string;
  usage: string;
  summary: string;
  raw?: (args: string[]) => boolean;
  run(args: string[]): unknown;
};

export class Ran {
  constructor(
    readonly result: unknown,
    readonly exitCode: number,
  ) {}
}

export class UsageError extends Error {
  readonly code = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
