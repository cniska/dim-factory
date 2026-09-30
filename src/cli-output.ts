import { type Command, Ran, UsageError } from "./cli-contract";
import { CodedError, type RefusalRecord, recordOf } from "./coded-error";

function errorRecord(error: unknown, usage: string): RefusalRecord {
  if (error instanceof CodedError) return recordOf(error);
  if (error instanceof UsageError) {
    return { code: "usage", message: error.message, meta: {}, resolve: usage.replace(/^usage: /, "") };
  }
  return {
    code: "command_failed",
    message: error instanceof Error ? error.message : String(error),
    meta: {},
    resolve: "dim doctor",
  };
}

export function writeResult(command: string, value: unknown): number {
  const { result, exitCode } = value instanceof Ran ? value : { result: value, exitCode: 0 };
  process.stdout.write(`${JSON.stringify({ command, ok: exitCode === 0, result: result ?? null })}\n`);
  return exitCode;
}

export function writeError(command: string, error: unknown, usage: string): number {
  process.stderr.write(`${JSON.stringify({ command, ok: false, error: errorRecord(error, usage) })}\n`);
  return 1;
}

export function listing(commands: readonly Command[]): {
  commands: { name: string; usage: string; summary: string }[];
} {
  return { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}
