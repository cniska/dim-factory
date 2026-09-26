import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectsDir, type Env, resolveHomeDir } from "./paths";

export function listInstalledSkills(env: Env = process.env): Set<string> {
  const home = resolveHomeDir(env);
  const roots = [
    join(home, ".agents", "skills"),
    join(dirname(claudeProjectsDir(env)), "skills"),
    join(home, ".claude", "skills"),
  ];
  const names = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (existsSync(join(root, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return names;
}
