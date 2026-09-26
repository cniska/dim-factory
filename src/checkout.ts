import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function checkoutRoot(dir: string): string | null {
  for (let at = resolve(dir), prev = ""; at !== prev; prev = at, at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
  }
  return null;
}
