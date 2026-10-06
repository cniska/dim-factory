import type { CodedError } from "./coded-error";

export type Health = { name: string; state: "ok" | "warn" | "fail"; detail: string; fix?: string };

export function refusedHealth(name: string, error: CodedError): Health {
  return { name, state: "fail", detail: error.message, fix: error.resolve };
}
