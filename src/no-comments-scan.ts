import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { CommentLanguage } from "./comments-language";
import { type PurgeReport, purgeCheckout } from "./comments-purge";
import { ran } from "./git";

export const SCANNER = "scan.cjs";

export function adaptersIn(dir: string): CommentLanguage[] {
  const load = createRequire(join(dir, SCANNER));
  return readdirSync(dir)
    .filter((file) => file.endsWith(".cjs") && file !== SCANNER)
    .sort()
    .map((file) => load(join(dir, file)).language);
}

export function scan(cwd: string, dir: string): PurgeReport {
  const root = ran(cwd, ["rev-parse", "--show-toplevel"]);
  return purgeCheckout(root, { write: false, languages: adaptersIn(dir), skipped: [relative(root, dir)] });
}

export function verdict({ files, unparsed }: PurgeReport): {
  readonly lines: string[];
  readonly failed: boolean;
} {
  const lines = [
    ...files.map(({ path, removed }) => `no-comments: ${path} holds ${removed} comment(s); remove them`),
    ...unparsed.map(
      (path) => `no-comments: ${path} does not parse, so its comments cannot be judged; fix its syntax`,
    ),
  ];
  return { lines, failed: lines.length > 0 };
}
