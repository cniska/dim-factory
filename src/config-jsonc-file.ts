import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc } from "./config-jsonc";

export function readJsoncText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function readJsonc<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseJsonc<T>(readFileSync(path, "utf8"), path);
}

export function writeJsoncFile(path: string, text: string): string | null {
  const backup = existsSync(path) ? `${path}.dim-backup` : null;
  if (backup) copyFileSync(path, backup);
  else mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return backup;
}
