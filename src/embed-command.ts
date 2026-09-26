import type { Command } from "./cli-contract";
import { closeDb, openDb } from "./db";
import { withLock } from "./db-lock";
import { committerName } from "./git-identity";
import { dbPath } from "./paths";
import { downloadEmbedder, EMBED_DIMS, EMBED_MODEL } from "./search-embed";
import { buildIndex } from "./search-embed-index";

export const embedCommand: Command = {
  name: "embed",
  usage: "usage: dim embed",
  summary:
    "index the text a person distilled — handoff nexts, their own commit subjects, labeled corrections — for q search",
  async run() {
    const embed = await downloadEmbedder();
    return await withLock(async () => {
      const db = openDb(dbPath());
      try {
        const report = await buildIndex(db, embed, committerName());
        return {
          model: EMBED_MODEL,
          dims: EMBED_DIMS,
          ...report,
          next:
            report.found.correction === 0
              ? "no prompt is labeled a correction yet; dim q candidates narrows, dim label records"
              : null,
        };
      } finally {
        closeDb(db);
      }
    });
  },
};
