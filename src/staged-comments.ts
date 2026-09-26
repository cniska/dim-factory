import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParserPlugin, parse } from "@babel/parser";

export type AddedComment = { path: string; line: number };
export type StagedComments = { found: AddedComment[]; unparsed: string[] };

type Comment = { type: "CommentLine" | "CommentBlock"; value: string; start: number; end: number };

const JUDGED = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TYPED_BY_JSDOC = /\.(?:js|mjs|cjs)$/;
const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;
const CONTRACT = /^(?:@ts-|eslint-|biome-ignore|prettier-ignore|[#@]__PURE__)/;

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function nulFields(output: string, command: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error(`${command} printed a record that does not end in NUL`);
  return output.slice(0, -1).split("\0");
}

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
    if (JUDGED.test(to)) files.set(to, renamed ? [from, to] : [to]);
  }
  return files;
}

function outsideTheCode(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const command = "git check-attr --stdin --cached -z";
  const fields = nulFields(
    git(
      root,
      ["check-attr", "--stdin", "--cached", "-z", "linguist-generated", "linguist-vendored"],
      paths.map((p) => `${p}\0`).join(""),
    ),
    command,
  );
  if (fields.length % 3 !== 0) throw new Error(`${command} printed ${fields.length} fields, not triples`);
  const skipped = new Set<string>();
  for (let at = 0; at < fields.length; at += 3) {
    const value = fields[at + 2];
    if (value === "set" || value === "true") skipped.add(fields[at] as string);
  }
  return skipped;
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

function comments(path: string, text: string): Comment[] | null {
  const language: ParserPlugin[] = /\.(?:ts|mts|cts)$/.test(path)
    ? ["typescript"]
    : path.endsWith(".tsx")
      ? ["typescript", "jsx"]
      : ["jsx"];
  const plugins: ParserPlugin[] = [...language, ["decorators", {}], "decoratorAutoAccessors"];
  try {
    return parse(text, {
      sourceType: "unambiguous",
      plugins,
      errorRecovery: true,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    }).comments as Comment[];
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isToolContract(comment: Comment, typedByJsdoc: boolean): boolean {
  if (comment.type === "CommentLine" && /^\/\s*<reference\b/.test(comment.value)) return true;
  if (comment.type === "CommentBlock" && comment.value.startsWith("!")) return true;
  const body = comment.value.replace(/^[\s*]*/, "");
  if (CONTRACT.test(body)) return true;
  if (!typedByJsdoc || comment.type !== "CommentBlock" || !comment.value.startsWith("*")) return false;
  if (/^@(?:type|typedef)\b/.test(body)) return true;
  const lines = comment.value
    .split("\n")
    .map((line) => line.replace(/^[\s*]*/, "").trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => /^@param\b/.test(line));
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
    const parsed = comments(path, text);
    if (parsed === null) {
      unparsed.push(path);
      continue;
    }
    const newlines = [...text.matchAll(/\n/g)].map((m) => m.index);
    const typedByJsdoc = TYPED_BY_JSDOC.test(path);
    for (const comment of parsed) {
      if (isToolContract(comment, typedByJsdoc)) continue;
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
