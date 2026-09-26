import { type Command, Ran } from "./cli-contract";

type ErrorRecord = { name: string; code: string; message: string; usage?: string };

function errorRecord(error: unknown, usage: string | undefined): ErrorRecord {
  if (!(error instanceof Error))
    return { name: "UnknownError", code: "command_failed", message: String(error) };
  const code = "code" in error && typeof error.code === "string" ? error.code : "command_failed";
  const record = { name: error.name, code, message: error.message };
  return code === "usage" && usage !== undefined ? { ...record, usage } : record;
}

export function writeResult(command: string, value: unknown): number {
  const { result, exitCode } = value instanceof Ran ? value : { result: value, exitCode: 0 };
  process.stdout.write(`${JSON.stringify({ command, ok: exitCode === 0, result: result ?? null })}\n`);
  return exitCode;
}

export function writeError(command: string, error: unknown, usage?: string): number {
  process.stderr.write(`${JSON.stringify({ command, ok: false, error: errorRecord(error, usage) })}\n`);
  return 1;
}

export function listing(commands: readonly Command[]): {
  commands: { name: string; usage: string; summary: string }[];
} {
  return { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })) };
}
