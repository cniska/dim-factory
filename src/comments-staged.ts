import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { git, nulFields, outsideTheCode } from "./comments-files";
import { languageFor } from "./comments-language";

export type AddedComment = { path: string; line: number };
export type StagedComments = { found: AddedComment[]; unparsed: string[] };

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

function changedFiles(root: string, base: string[]): Map<string, string[]> {
  const command = `git diff --cached --name-status -z ${base.join(" ")}`.trim();
  const fields = nulFields(
    git(root, ["diff", "--cached", "--name-status", "-z", "-M", "--diff-filter=AMRT", ...base]),
    command,
  );
  const files = new Map<string, string[]>();
  let at = 0;
  while (at < fields.length) {
    const status = fields[at] as string;
    const renamed = status.startsWith("R");
    const width = renamed ? 3 : 2;
    if (!/^[AMRT]\d*$/.test(status) || at + width > fields.length) {
      throw new Error(
        `${command} printed a record this cannot read: ${JSON.stringify(fields.slice(at, at + 3))}`,
      );
    }
    const from = fields[at + 1] as string;
    const to = fields[at + width - 1] as string;
    at += width;
    if (languageFor(to)) files.set(to, renamed ? [from, to] : [to]);
  }
  return files;
}

function addedLines(root: string, pathspec: string[], base: string[]): Set<number> {
  const diff = git(root, [
    "diff",
    "--cached",
    "-U0",
    "-M",
    "--no-color",
    "--no-ext-diff",
    ...base,
    "--",
    ...pathspec,
  ]);
  const lines = new Set<number>();
  for (const header of diff.split("\n")) {
    const hunk = HUNK.exec(header);
    if (!hunk) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let line = first; line < first + count; line++) lines.add(line);
  }
  return lines;
}

function mergeHeads(root: string): string[] {
  const path = resolve(root, git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim());
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function lineAt(newlines: number[], offset: number): number {
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((newlines[mid] as number) < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

export function stagedComments(root: string): StagedComments {
  const found: AddedComment[] = [];
  const unparsed: string[] = [];
  const ours = changedFiles(root, []);
  const theirs = mergeHeads(root).map((head) => ({ head, files: changedFiles(root, [head]) }));
  const skipped = outsideTheCode(root, [...ours.keys()]);
  files: for (const [path, pathspec] of ours) {
    if (skipped.has(path)) continue;
    let added = addedLines(root, pathspec, []);
    for (const { head, files } of theirs) {
      const theirPathspec = files.get(path);
      if (theirPathspec === undefined) continue files;
      const lines = addedLines(root, theirPathspec, [head]);
      added = new Set([...added].filter((line) => lines.has(line)));
    }
    if (added.size === 0) continue;
    const text = git(root, ["show", `:${path}`]);
    const comments = languageFor(path)?.comments(path, text, { recover: true }) ?? null;
    if (comments === null) {
      unparsed.push(path);
      continue;
    }
    const newlines = [...text.matchAll(/\n/g)].map((m) => m.index);
    for (const comment of comments) {
      const last = lineAt(newlines, comment.end - 1);
      for (let line = lineAt(newlines, comment.start); line <= last; line++) {
        if (added.has(line)) {
          found.push({ path, line });
          break;
        }
      }
    }
  }
  found.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { found, unparsed };
}
