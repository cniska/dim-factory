import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectsDir, type Env, resolveHomeDir } from "./paths";

/**
 * A typed `/name` is a skill load only when a skill by that name exists. Claude
 * Code's own commands share the syntax — `/clear` alone accounts for 280 of them
 * in this corpus — and counting those as skill loads would put a built-in at the
 * top of every ranking.
 *
 * Read from disk, so a skill deleted since its sessions were recorded is missed.
 * The alternative, a list of built-ins to exclude, goes stale in the direction
 * that invents data rather than the one that omits it.
 */
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
