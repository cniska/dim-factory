export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";

  constructor(
    readonly code: Code,
    message: string,
    readonly meta: Meta,
    readonly resolve: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type RefusalRecord = {
  readonly code: string;
  readonly message: string;
  readonly meta: object;
  readonly resolve: string;
};

export function refusalOf({ code, message, meta, resolve }: RefusalRecord): CodedError {
  return new CodedError(code, message, meta, resolve);
}

export type RefusalTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: {
    readonly message: (meta: Metas[Code]) => string;
    readonly resolve: (meta: Metas[Code]) => string;
  };
};

export function refuser<Metas extends Record<string, object>>(table: RefusalTable<Metas>) {
  return <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Code, Metas[Code]> =>
    new CodedError(code, table[code].message(meta), meta, table[code].resolve(meta));
}
