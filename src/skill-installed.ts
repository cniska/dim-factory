import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES } from "./harness-contract";
import type { Env } from "./paths";

export function listInstalledSkills(env: Env = process.env): Set<string> {
  const root = HARNESSES.claude.skillDir(env);
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root).filter((entry) => existsSync(join(root, entry, "SKILL.md"))));
}
