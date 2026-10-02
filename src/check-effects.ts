import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv, outputTail, sandboxProfile } from "./check";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";

export function runCheck(trace: Trace, tree: string, commandLine: string, owner: Env): Evidence {
  return trace.step(
    "check",
    { tree, command: commandLine },
    (): Evidence => {
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
    },
    (evidence) => ({ exitCode: evidence.exitCode }),
  );
}
