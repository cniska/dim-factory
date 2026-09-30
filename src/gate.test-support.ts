import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { hookBody } from "./gate-hooks";

let bin: string | undefined;

function dimBin(): string {
  if (!bin) {
    bin = mkdtempSync(join(tmpdir(), "dim-gate-bin-"));
    writeFileSync(
      join(bin, "dim"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "cli.ts")}" "$@"\n`,
    );
    chmodSync(join(bin, "dim"), 0o755);
  }
  return bin;
}

export function pathWithDim(path = process.env.PATH ?? ""): string {
  return `${dimBin()}${delimiter}${path}`;
}

export function installHook(hooks: string, hook: string, owners: string[]): string {
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, hook);
  writeFileSync(path, hookBody(owners));
  chmodSync(path, 0o755);
  return path;
}
