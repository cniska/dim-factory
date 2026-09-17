/**
 * One type for every way a tool's own config defeats a read or a write, so a
 * caller branches on `kind` rather than on a message. `path` is always the file;
 * `at` is set only where a place inside the document is the subject.
 */
export class ConfigError extends Error {
  constructor(
    readonly kind: "parse" | "not-an-array" | "not-an-object" | "unwritable",
    readonly path: string,
    message: string,
    readonly at?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
