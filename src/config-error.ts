export class ConfigError extends Error {
  constructor(
    readonly kind: "parse" | "invalid" | "not-an-array" | "not-an-object" | "unwritable" | "absent",
    readonly path: string,
    message: string,
    readonly at?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
