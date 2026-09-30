import { z } from "zod";
import { refuser } from "./coded-error";

export const Strength = z.enum(["standard", "deep"]);
export type Strength = z.infer<typeof Strength>;

export const Models = z.record(z.string(), z.object({ standard: z.string(), deep: z.string() }));
export type Models = z.infer<typeof Models>;

export type SessionStart =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string };

export type Start = {
  readonly session: SessionStart;
  readonly model: string;
  readonly workspace: string;
  readonly tmp: string;
  readonly socket: string;
};

export type Outcome =
  | { readonly kind: "finished"; readonly text: string }
  | { readonly kind: "limited"; readonly resetsAt: string | null }
  | { readonly kind: "unfinished" };

export type Adapter = {
  readonly signIn: readonly string[];
  argv(start: Start): readonly string[];
  outcome(lines: readonly string[]): Outcome;
  transcript(home: string, workspace: string, session: string): string;
};

type HarnessRefusalMeta = {
  readonly no_model: { readonly harness: string; readonly strength: Strength; readonly file: string };
  readonly no_adapter: { readonly harness: string };
};

export const refuseHarness = refuser<HarnessRefusalMeta>({
  no_model: {
    message: ({ harness, strength, file }) =>
      `${file} names no ${strength} model for ${harness}, so no worker of that strength can start`,
    resolve: () => "dim doctor",
  },
  no_adapter: {
    message: ({ harness }) =>
      `dim cannot start a station worker under ${harness}; Claude Code is the harness built`,
    resolve: () => "dim config set harness claude",
  },
});
