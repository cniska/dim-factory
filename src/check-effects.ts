import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv, outputTail, sandboxProfile } from "./check";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";

export type CheckEvidence = Extract<Evidence, { readonly kind: "check" }>;

export function runCheck(tree: string, commandLine: string, owner: Env): CheckEvidence {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dim-check-")));
  try {
    const profile = sandboxProfile([realpathSync(tree), tmp]);
    const ran = Bun.spawnSync(["sandbox-exec", "-p", profile, "sh", "-c", `${commandLine} 2>&1`], {
      cwd: tree,
      env: checkEnv(owner, tmp),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      kind: "check",
      command: commandLine,
      exitCode: ran.exitCode,
      output: outputTail(`${ran.stdout.toString()}${ran.stderr.toString()}`),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
