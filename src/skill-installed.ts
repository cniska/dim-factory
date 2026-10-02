import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, type Env, resolveHomeDir } from "./paths";

export function listInstalledSkills(env: Env = process.env): Set<string> {
  const home = resolveHomeDir(env);
  const roots = [join(home, ".agents", "skills"), join(claudeDir(env), "skills")];
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
