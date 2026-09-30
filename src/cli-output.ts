import { type Command, Ran } from "./cli-contract";
import { isRefusalCode, resolveOf } from "./cli-refusals";
import { CodedError } from "./coded-error";

type ErrorRecord = {
  readonly code: string;
  readonly message: string;
  readonly meta: object;
  readonly resolve: string;
};

function errorRecord(error: unknown, command: string, usage: string): ErrorRecord {
  const context = { command, usage: usage.replace(/^usage: /, "") };
  if (error instanceof CodedError && isRefusalCode(error.code)) {
    return {
      code: error.code,
      message: error.message,
      meta: error.meta,
      resolve: resolveOf(error.code, context),
    };
  }
  return {
    code: "command_failed",
    message: error instanceof Error ? error.message : String(error),
    meta: {},
    resolve: resolveOf("command_failed", context),
  };
}

export function writeResult(command: string, value: unknown): number {
  const { result, exitCode } = value instanceof Ran ? value : { result: value, exitCode: 0 };
  process.stdout.write(`${JSON.stringify({ command, ok: exitCode === 0, result: result ?? null })}\n`);
  return exitCode;
}

export function writeError(command: string, error: unknown, usage: string): number {
  process.stderr.write(
    `${JSON.stringify({ command, ok: false, error: errorRecord(error, command, usage) })}\n`,
  );
  return 1;
}

export function listing(commands: readonly Command[]): {
  commands: { name: string; usage: string; summary: string }[];
} {
  return { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}
