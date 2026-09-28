import { join, resolve } from "node:path";

const CHECKOUT = resolve(import.meta.dir, "..");

export const SKILLS_DIR = join(CHECKOUT, "skills");

export const SKILL_PLUGIN_DIR = join(CHECKOUT, "plugin");
