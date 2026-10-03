import { z } from "zod";

export type ErrorKind = "refusal" | "fault";

export const BUG = "stop and hand this error to the owner as a bug in dim; no command you run resolves it";

export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";

  constructor(
    readonly code: Code,
    message: string,
    readonly meta: Meta,
    readonly resolve: string,
    readonly kind: ErrorKind,
  ) {
    super(message);
  }
}

export function isRefusal(error: unknown): error is CodedError {
  return error instanceof CodedError && error.kind === "refusal";
}

export const RefusalRecord = z.object({
  code: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()),
  resolve: z.string(),
});
export type RefusalRecord = z.infer<typeof RefusalRecord>;

export function recordOf(error: CodedError): RefusalRecord {
  return { code: error.code, message: error.message, meta: { ...error.meta }, resolve: error.resolve };
}

export function refusalOf({ code, message, meta, resolve }: RefusalRecord): CodedError {
  return new CodedError(code, message, meta, resolve, "refusal");
}

export type RefusalTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

function coder(kind: ErrorKind) {
  return <Metas extends Record<string, object>>(table: RefusalTable<Metas>) =>
    <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Code, Metas[Code]> =>
      new CodedError(code, table[code].message(meta), meta, table[code].resolve(meta), kind);
}

export const refuser = coder("refusal");

export const faulter = coder("fault");
