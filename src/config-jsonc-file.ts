import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { parseJsonc } from "./config-jsonc";
import { copyBackup } from "./file-backup";

export function readJsoncText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function readJsonc<S extends z.ZodType>(path: string, schema: S): z.infer<S> | null {
  if (!existsSync(path)) return null;
  return parseJsonc(readFileSync(path, "utf8"), path, schema);
}

export function writeJsoncFile(path: string, text: string): string | null {
  if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
  const backup = existsSync(path) ? copyBackup(path) : null;
  writeFileSync(path, text);
  return backup;
}
