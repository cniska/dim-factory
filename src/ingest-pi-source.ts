import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import type { SourceFile } from "./ingest";
import { parsePiChunk } from "./ingest-parse-pi";

export function listPiSessions(root: string): SourceFile[] {
  if (!existsSync(root)) return [];
  return [...new Glob("*/*.jsonl").scanSync({ cwd: root, absolute: true })].sort().map((path) => ({
    path,
    kind: "transcript",
    sessionId: basename(path, ".jsonl").slice(basename(path).indexOf("_") + 1),
    parse: (lines, first) => parsePiChunk(lines, first),
  }));
}
