import { extname } from "node:path";
import { trackedFiles } from "./comments-files";

export const LANGUAGES = {
  typescript: { extensions: [".ts", ".tsx", ".mts", ".cts"] },
} as const satisfies Record<string, { readonly extensions: readonly string[] }>;

export type Language = keyof typeof LANGUAGES;

const LANGUAGE_NAMES = Object.keys(LANGUAGES).filter((name): name is Language =>
  Object.hasOwn(LANGUAGES, name),
);

export function languagesOf(root: string): Language[] {
  const extensions = new Set(trackedFiles(root, []).map((path) => extname(path)));
  return LANGUAGE_NAMES.filter((name) =>
    LANGUAGES[name].extensions.some((extension) => extensions.has(extension)),
  );
}
