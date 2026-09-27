import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc } from "./config-jsonc";
import { copyBackup } from "./file-backup";

export function readJsoncText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function readJsonc<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseJsonc<T>(readFileSync(path, "utf8"), path);
}

export function writeJsoncFile(path: string, text: string): string | null {
  if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
  const backup = existsSync(path) ? copyBackup(path) : null;
  writeFileSync(path, text);
  return backup;
}
