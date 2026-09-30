import { CodedError } from "./coded-error";

const CONFIG_CODES = {
  parse: "config_unparsed",
  invalid: "config_invalid",
  "not-an-array": "config_not_an_array",
  "not-an-object": "config_not_an_object",
  unwritable: "config_unwritable",
  absent: "config_absent",
} as const;

export type ConfigErrorKind = keyof typeof CONFIG_CODES;

export type ConfigErrorCode = (typeof CONFIG_CODES)[ConfigErrorKind];

export type ConfigErrorMeta = { readonly path: string; readonly at: string | null };

export class ConfigError extends CodedError<ConfigErrorCode, ConfigErrorMeta> {
  constructor(
    readonly kind: ConfigErrorKind,
    readonly path: string,
    message: string,
    readonly at?: string,
  ) {
    super(CONFIG_CODES[kind], message, { path, at: at ?? null }, "dim config");
  }
}
