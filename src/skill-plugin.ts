import { join, resolve } from "node:path";

export const SKILL_PLUGIN_DIR = resolve(import.meta.dir, "..");

export const SKILLS_DIR = join(SKILL_PLUGIN_DIR, "skills");
