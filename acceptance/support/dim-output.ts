import { z } from "zod";

export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const Refusal = z.strictObject({
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()),
  resolve: z.string(),
});

type Refusal = z.infer<typeof Refusal>;

export type DimResult<T> =
  | { readonly ok: true; readonly result: T; readonly ran: Ran }
  | { readonly ok: false; readonly error: Refusal; readonly ran: Ran };

export const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

export const commandLine = (args: readonly string[]): string => ["dim", ...args].map(quote).join(" ");

function lastLine(ran: Ran): string {
  return (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split("\n").at(-1) ?? "";
}

export function parseDim<T>(ran: Ran, schema: z.ZodType<T>): DimResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(lastLine(ran));
  } catch {
    throw new Error(`dim printed no structured result (exit ${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  }
  const printed = z
    .discriminatedUnion("ok", [
      z.strictObject({ command: z.string(), ok: z.literal(true), result: schema }),
      z.strictObject({ command: z.string(), ok: z.literal(false), error: Refusal }),
    ])
    .safeParse(json);
  if (!printed.success)
    throw new Error(
      `dim printed a result the test does not expect:\n${z.prettifyError(printed.error)}\n${JSON.stringify(json)}`,
    );
  return printed.data.ok
    ? { ok: true, result: printed.data.result, ran }
    : { ok: false, error: printed.data.error, ran };
}

export function refusal<T>(result: DimResult<T>): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.result)}`);
  return result.error;
}

export function resultOf<T>(result: DimResult<T>): T {
  if (!result.ok) throw new Error(`dim refused: ${JSON.stringify(result.error)}`);
  return result.result;
}
