import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkerHook } from "./worker-environment";

describe("worker environment hook reports", () => {
  test("capture argv, result, output, and explicit resource evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-worker-"));
    try {
      const hook = join(root, "hook.sh");
      writeFileSync(
        hook,
        '#!/usr/bin/env bash\nprintf \'{"resources":[{"kind":"container","id":"worker-db"}]}\\n\'\nprintf \'ready\\n\'\n',
      );
      chmodSync(hook, 0o755);

      expect(runWorkerHook("setup", hook, root)).toEqual({
        phase: "setup",
        argv: [hook],
        exitCode: 0,
        signal: null,
        stdout: '{"resources":[{"kind":"container","id":"worker-db"}]}\nready\n',
        stderr: "",
        resources: [{ kind: "container", id: "worker-db" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops malformed resource entries and reports signal termination", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-worker-"));
    try {
      const hook = join(root, "hook.sh");
      writeFileSync(
        hook,
        '#!/usr/bin/env bash\nprintf \'{"resources":[[],{"kind":"port"}]}\\n\'\nkill -9 $$\n',
      );
      chmodSync(hook, 0o755);

      const report = runWorkerHook("teardown", hook, root);
      expect(report.exitCode).toBeNull();
      expect(report.signal).toBe("SIGKILL");
      expect(report.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
