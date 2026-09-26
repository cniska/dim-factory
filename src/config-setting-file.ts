import { existsSync } from "node:fs";
import { duplicateKeys, parseJsonc } from "./config-jsonc";
import { readJsoncText } from "./config-jsonc-file";

export type SettingDefect =
  | { kind: "duplicate-key"; keys: string[] }
  | { kind: "not-object" }
  | { kind: "unknown-key"; keys: string[] };

export type SettingShape = {
  isKey: (key: string) => boolean;
  refuse: (defect: SettingDefect) => Error;
};

export function parseSetting(text: string, file: string, shape: SettingShape): Record<string, unknown> {
  const repeated = duplicateKeys(text, { deep: true });
  if (repeated.length > 0) throw shape.refuse({ kind: "duplicate-key", keys: repeated });
  const raw = parseJsonc<unknown>(text, file);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw shape.refuse({ kind: "not-object" });
  const unknown = Object.keys(raw).filter((key) => !shape.isKey(key));
  if (unknown.length > 0) throw shape.refuse({ kind: "unknown-key", keys: unknown });
  return raw as Record<string, unknown>;
}

export function readSettingFile(path: string, shape: SettingShape): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return parseSetting(readJsoncText(path), path, shape);
}
