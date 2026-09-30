export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

type Refusal = {
  readonly code: string;
  readonly message: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly resolve: string;
};

export type DimResult =
  | { readonly ok: true; readonly result: unknown; readonly ran: Ran }
  | { readonly ok: false; readonly error: Refusal; readonly ran: Ran };

export const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

export const commandLine = (args: readonly string[]): string => ["dim", ...args].map(quote).join(" ");

function lastLine(ran: Ran): string {
  return (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split("\n").at(-1) ?? "";
}

export function parseDim(ran: Ran): DimResult {
  let parsed: { ok?: unknown; result?: unknown; error?: Refusal };
  try {
    parsed = JSON.parse(lastLine(ran));
  } catch {
    throw new Error(`dim printed no structured result (exit ${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  }
  if (parsed.ok === true) return { ok: true, result: parsed.result, ran };
  if (parsed.error === undefined) throw new Error(`dim refused without an error:\n${ran.stderr}`);
  return { ok: false, error: parsed.error, ran };
}

export function refusal(result: DimResult): Refusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.result)}`);
  return result.error;
}

export function resultOf(result: DimResult): unknown {
  if (!result.ok) throw new Error(`dim refused: ${JSON.stringify(result.error)}`);
  return result.result;
}
