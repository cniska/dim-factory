import type { Env } from "./paths";
import type { Trace } from "./trace-contract";

export type Toolchain =
  | { readonly kind: "resolved"; readonly bins: readonly string[] }
  | { readonly kind: "failed"; readonly output: string };

export function resolveToolchain(trace: Trace, checkout: string, env: Env): Toolchain {
  return trace.step(
    "toolchain",
    { checkout },
    (): Toolchain => {
      const mise = Bun.which("mise", { PATH: env.PATH ?? "" });
      if (mise === null) return { kind: "resolved", bins: [] };
      const ran = Bun.spawnSync([mise, "bin-paths"], { cwd: checkout, env, stdout: "pipe", stderr: "pipe" });
      if (ran.exitCode !== 0)
        return { kind: "failed", output: `${ran.stdout.toString()}${ran.stderr.toString()}` };
      return { kind: "resolved", bins: ran.stdout.toString().split("\n").filter(Boolean) };
    },
    (toolchain) => ({ bins: toolchain.kind === "resolved" ? toolchain.bins : [] }),
  );
}
