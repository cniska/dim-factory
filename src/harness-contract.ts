import { join } from "node:path";
import { z } from "zod";
import { claudeDir, type Env } from "./paths";

export const HarnessName = z.enum(["claude"]);
export type HarnessName = z.infer<typeof HarnessName>;

export const EditInput = z.object({ file_path: z.string(), notebook_path: z.string() }).partial();
export type EditInput = z.infer<typeof EditInput>;

export type Harness = {
  readonly name: HarnessName;
  hookConfig(env: Env): string;
  skillDir(env: Env): string;
  readonly editTools: readonly string[];
  editedPaths(input: EditInput): readonly string[];
};

export const HARNESSES: Readonly<Record<HarnessName, Harness>> = {
  claude: {
    name: "claude",
    hookConfig: (env) => join(claudeDir(env), "settings.json"),
    skillDir: (env) => join(claudeDir(env), "skills"),
    editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    editedPaths: ({ file_path, notebook_path }) => {
      const path = file_path ?? notebook_path;
      return path === undefined ? [] : [path];
    },
  },
};

export type Policy = {
  readonly writable: readonly string[];
  readonly denied: readonly string[];
  readonly unedited: readonly string[];
  readonly web: boolean;
};

export type SessionStart =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string };

export type Outcome =
  | { readonly kind: "finished"; readonly result: string | null }
  | { readonly kind: "died"; readonly code: "killed" | "resume_failed" }
  | { readonly kind: "died"; readonly code: "usage_limit"; readonly resetsAt: string | null };

export type Start = {
  readonly session: SessionStart;
  readonly model: string;
  readonly instructions: string;
  readonly policy: Policy;
  readonly socket: string;
};

export type Ended = {
  readonly lines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
};

export type Spawn = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly session: string;
  readonly heard: (line: string) => void;
};

export type Spawned = {
  readonly pid: number;
  prompt(text: string): void;
  kill(): void;
  readonly ended: Promise<Ended>;
};

export type Adapter = {
  readonly name: HarnessName;
  readonly signIn: readonly string[];
  readonly tempRoot: string;
  argv(start: Start): readonly string[];
  transcript(home: string, workspace: string, session: string): string;
  subagents(home: string, workspace: string, session: string): string;
  outcome(ended: Ended, session: SessionStart): Outcome;
};
