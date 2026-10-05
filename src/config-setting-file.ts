import { z } from "zod";
import { duplicateKeys, parseJsonc } from "./config-jsonc";

export type SettingDefect =
  | { kind: "duplicate-key"; keys: string[] }
  | { kind: "not-object" }
  | { kind: "unknown-key"; keys: string[] };

type SettingShape = {
  isKey: (key: string) => boolean;
  refuse: (defect: SettingDefect) => Error;
};

export function parseSetting(text: string, file: string, shape: SettingShape): Record<string, unknown> {
  const repeated = duplicateKeys(text, { deep: true });
  if (repeated.length > 0) throw shape.refuse({ kind: "duplicate-key", keys: repeated });
  const raw = parseJsonc(text, file, z.unknown());
  const settings = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!settings.success) throw shape.refuse({ kind: "not-object" });
  const unknown = Object.keys(settings.data).filter((key) => !shape.isKey(key));
  if (unknown.length > 0) throw shape.refuse({ kind: "unknown-key", keys: unknown });
  return settings.data;
}
