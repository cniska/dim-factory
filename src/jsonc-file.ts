import { existsSync, readFileSync } from "node:fs";
import { parseJsonc } from "./jsonc";

/** Empty where the file is absent, which is the text an edit starts from. */
export function readJsoncText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Null where the file is absent. */
export function readJsonc<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseJsonc<T>(readFileSync(path, "utf8"), path);
}
