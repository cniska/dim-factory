export class CodedError<Code extends string = string, Meta extends object = object> extends Error {
  override readonly name = "CodedError";

  constructor(
    readonly code: Code,
    message: string,
    readonly meta: Meta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type MessageTable<Metas extends Record<string, object>> = {
  readonly [Code in keyof Metas]: (meta: Metas[Code]) => string;
};

export function refuser<Metas extends Record<string, object>>(messages: MessageTable<Metas>) {
  return <Code extends keyof Metas & string>(code: Code, meta: Metas[Code]): CodedError<Code, Metas[Code]> =>
    new CodedError(code, messages[code](meta), meta);
}
