import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./processes";

const MACHINE_DIR = /^dim-acceptance-(\d+)-/;

export function machineRoot(tmp: string): string {
  for (const entry of readdirSync(tmp)) {
    const owner = MACHINE_DIR.exec(entry)?.[1];
    if (owner !== undefined && !alive(Number(owner)))
      rmSync(join(tmp, entry), { recursive: true, force: true });
  }
  return mkdtempSync(join(tmp, `dim-acceptance-${process.pid}-`));
}
