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
