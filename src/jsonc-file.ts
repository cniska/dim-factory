import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * Overwrite a config a person hand-edits, copying the original beside itself
 * first so a bad write is recoverable. Returns the backup's path, or null where
 * there was nothing yet to copy.
 */
export function writeJsoncFile(path: string, text: string): string | null {
  const backup = existsSync(path) ? `${path}.dim-backup` : null;
  if (backup) copyFileSync(path, backup);
  else mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return backup;
}
