import type { Database } from "bun:sqlite";
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import { createIngester } from "./ingest";
import { liveSessionFiles } from "./ingest-claude-source";

export function followUsage(db: Database, transcript: string): () => void {
  const ingester = createIngester(db);
  let failure: { readonly error: unknown } | null = null;
  let pending = false;
  const read = () => {
    pending = false;
    if (failure !== null) return;
    try {
      for (const file of liveSessionFiles(transcript)) ingester.ingestFile({ ...file, tool: "claude" });
    } catch (error) {
      failure = { error };
      watcher.close();
    }
  };
  const dir = dirname(transcript);
  mkdirSync(dir, { recursive: true });
  const watcher: FSWatcher = watch(dir, { recursive: true }, () => {
    if (pending) return;
    pending = true;
    setImmediate(read);
  });
  watcher.on("error", (error) => {
    failure = { error };
    watcher.close();
  });
  return () => {
    watcher.close();
    read();
    if (failure !== null) throw failure.error;
  };
}
