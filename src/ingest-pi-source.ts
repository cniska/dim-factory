import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import type { FileSpec } from "./ingest";
import { parsePiChunk } from "./ingest-parse-pi";
import type { Tool } from "./ingest-tools";

export function listPiSessions(tool: Extract<Tool, "pi" | "omp">, root: string): FileSpec[] {
  if (!existsSync(root)) return [];
  return [...new Glob("*/*.jsonl").scanSync({ cwd: root, absolute: true })].sort().map((path) => ({
    path,
    tool,
    kind: "transcript",
    sessionId: basename(path, ".jsonl").slice(basename(path).indexOf("_") + 1),
    parse: (lines, first) => parsePiChunk(lines, first),
  }));
}
