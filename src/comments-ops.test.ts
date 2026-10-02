import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeComments } from "./comments-ops";

test("refuses a directory outside any git checkout, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dim-comments-"));
  try {
    expect(() => purgeComments(dir, { write: false, paths: [] })).toThrow(
      expect.objectContaining({ code: "not_a_checkout", kind: "refusal", meta: { cwd: dir } }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
