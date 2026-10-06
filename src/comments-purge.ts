import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outsideTheCode, trackedFiles } from "./comments-files";
import { type CommentLanguage, type CommentSpan, languageFor } from "./comments-language";

export type PurgedFile = { path: string; removed: number };
export type PurgeReport = { files: PurgedFile[]; unparsed: string[] };

export type PurgeOptions = {
  readonly write: boolean;
  readonly languages: readonly CommentLanguage[];
  readonly paths?: readonly string[];
  readonly skipped?: readonly string[];
};

function withItsLine(text: string, { start, end }: CommentSpan): [number, number] {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  const aloneBefore = /^[ \t]*$/.test(text.slice(lineStart, start));
  const aloneAfter = /^[ \t]*$/.test(text.slice(end, lineEnd));
  if (aloneBefore && aloneAfter) return [lineStart, newline === -1 ? text.length : newline + 1];
  if (aloneBefore) return [start, end + (/^[ \t]*/.exec(text.slice(end))?.[0].length ?? 0)];
  return [start - (/[ \t]*$/.exec(text.slice(0, start))?.[0].length ?? 0), end];
}

export function purgeText(
  path: string,
  text: string,
  languages: readonly CommentLanguage[],
): { text: string; removed: number } | null {
  const language = languageFor(path, languages);
  const comments = language?.comments(path, text, { recover: false }) ?? null;
  if (language === undefined || comments === null) return null;
  const spans = comments
    .map((comment) => withItsLine(text, language.extent(path, text, comment)))
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let at = 0;
  for (const [start, end] of merged) {
    out += text.slice(at, start);
    at = end;
  }
  return { text: out + text.slice(at), removed: spans.length };
}

export function purgeCheckout(root: string, options: PurgeOptions): PurgeReport {
  const { languages } = options;
  const skippedDirs = options.skipped ?? [];
  const tracked = trackedFiles(root, options.paths ?? []).filter(
    (path) =>
      languageFor(path, languages) !== undefined && !skippedDirs.some((dir) => path.startsWith(`${dir}/`)),
  );
  const skipped = outsideTheCode(root, tracked);
  const files: PurgedFile[] = [];
  const unparsed: string[] = [];
  for (const path of tracked) {
    if (skipped.has(path)) continue;
    const full = join(root, path);
    const purged = purgeText(path, readFileSync(full, "utf8"), languages);
    if (purged === null) {
      unparsed.push(path);
      continue;
    }
    if (purged.removed === 0) continue;
    if (options.write) writeFileSync(full, purged.text);
    files.push({ path, removed: purged.removed });
  }
  return { files, unparsed };
}
