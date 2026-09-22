type FactoryError = {
  name: string;
  code: string;
  message: string;
};

function errorRecord(error: unknown): FactoryError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "command_failed";
    return { name: error.name, code, message: error.message };
  }
  return { name: "UnknownError", code: "command_failed", message: String(error) };
}

function resultRecord(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return { message: result };
  }
}

export function writeFactorySuccess(command: string, result: unknown): void {
  process.stdout.write(
    `${JSON.stringify({ type: "factory", command, ok: true, result: resultRecord(result) })}\n`,
  );
}

export function writeFactoryError(command: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ type: "factory", command, ok: false, error: errorRecord(error) })}\n`,
  );
}
