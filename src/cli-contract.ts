import { CodedError } from "./coded-error";

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

export class UsageError extends CodedError<"usage", Record<string, never>> {
  constructor(message: string) {
    super("usage", message, {});
  }
}
