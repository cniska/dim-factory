import { existsSync, readFileSync } from "node:fs";
import { Models } from "./harness-contract";

export function readModels(path: string): Models {
  return existsSync(path) ? Models.parse(JSON.parse(readFileSync(path, "utf8"))) : {};
}

export type Held = {
  readonly pid: number;
  release(prompt: string): void;
  readonly ended: Promise<{ readonly lines: readonly string[]; readonly exitCode: number | null }>;
};

const WAIT_FOR_RELEASE = 'read -r _ && exec "$0" "$@"';

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<readonly string[]> {
  return (await new Response(stream).text()).split("\n").filter((line) => line.trim() !== "");
}

export function holdHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Held {
  const child = Bun.spawn(["sh", "-c", WAIT_FOR_RELEASE, ...argv], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  return {
    pid: child.pid,
    release(prompt) {
      child.stdin.write(`\n${prompt}`);
      child.stdin.end();
    },
    ended: Promise.all([linesOf(child.stdout), child.exited]).then(([lines]) => ({
      lines,
      exitCode: child.exitCode,
    })),
  };
}
