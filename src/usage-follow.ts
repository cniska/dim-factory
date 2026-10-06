import type { Database } from "bun:sqlite";
import { createIngester } from "./ingest";
import { liveSessionFiles } from "./ingest-claude-source";

export type UsageFollow = {
  readonly heard: () => void;
  readonly stop: () => void;
};

export function followUsage(db: Database, transcript: string): UsageFollow {
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
    }
  };
  return {
    heard() {
      if (pending) return;
      pending = true;
      setImmediate(read);
    },
    stop() {
      read();
      if (failure !== null) throw failure.error;
    },
  };
}
