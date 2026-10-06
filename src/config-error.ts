import { z } from "zod";
import { CodedError, type ErrorTable, refuser } from "./coded-error";

type In = { readonly path: string };

type At = In & { readonly at: string };

type ConfigMetas = {
  readonly config_unparsed: In & { readonly detail: string };
  readonly config_invalid: In & { readonly at: string | null; readonly problem: string };
  readonly config_not_an_object: At & { readonly holds: string };
  readonly config_not_an_array: At & { readonly holds: string };
  readonly config_unwritable: At & { readonly event: string };
  readonly config_absent: At;
};

const resolve = () => "dim config";

const CONFIG_REFUSALS: ErrorTable<ConfigMetas> = {
  config_unparsed: { message: ({ path, detail }) => `${path}: ${detail}`, resolve },
  config_invalid: { message: ({ path, problem }) => `${path}: ${problem}`, resolve },
  config_not_an_object: { message: ({ at, holds }) => `${at} holds a ${holds}`, resolve },
  config_not_an_array: { message: ({ at, holds }) => `${at} holds a ${holds}`, resolve },
  config_unwritable: {
    message: ({ path, event }) =>
      `${path}: the ${event} hook would not land where a reader looks, so nothing was written`,
    resolve,
  },
  config_absent: { message: ({ path, at }) => `${path}: ${at} is not there to replace`, resolve },
};

export const refuseConfig = refuser(CONFIG_REFUSALS);

export type ConfigRefusal = CodedError<keyof ConfigMetas, In>;

export function isConfigRefusal(error: unknown): error is ConfigRefusal {
  return error instanceof CodedError && Object.hasOwn(CONFIG_REFUSALS, error.code);
}

export function invalidConfig(path: string, error: z.ZodError): ConfigRefusal {
  const first = error.issues[0]?.path;
  return refuseConfig("config_invalid", {
    path,
    at: first && first.length > 0 ? first.join(".") : null,
    problem: z.prettifyError(error),
  });
}
