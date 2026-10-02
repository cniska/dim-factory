import { join } from "node:path";
import { z } from "zod";
import { claudeDir, codexDir, type Env } from "./paths";

export const HarnessName = z.enum(["codex", "claude"]);
export type HarnessName = z.infer<typeof HarnessName>;

export type EditInput = { file_path?: unknown; notebook_path?: unknown; command?: unknown };

export type Harness = {
  readonly name: HarnessName;
  hookConfig(env: Env): string;
  readonly editTools: readonly string[];
  editedPaths(input: EditInput): readonly string[];
};

const PATCH_TARGET = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

export const HARNESSES: Readonly<Record<HarnessName, Harness>> = {
  codex: {
    name: "codex",
    hookConfig: (env) => join(codexDir(env), "hooks.json"),
    editTools: ["apply_patch"],
    editedPaths: ({ command }) =>
      typeof command === "string"
        ? [...command.matchAll(PATCH_TARGET)].map((match) => (match[1] as string).trim())
        : [],
  },
  claude: {
    name: "claude",
    hookConfig: (env) => join(claudeDir(env), "settings.json"),
    editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    editedPaths: ({ file_path, notebook_path }) => {
      const path = file_path ?? notebook_path;
      return typeof path === "string" ? [path] : [];
    },
  },
};
