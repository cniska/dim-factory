import { refuser } from "./coded-error";

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
  readonly no_adapter: { readonly harness: string };
};

export const refuseHarness = refuser<HarnessRefusalMeta>({
  no_adapter: {
    message: ({ harness }) =>
      `dim cannot start a station worker under ${harness}; Claude Code is the harness built`,
    resolve: () => "dim config set harness claude",
  },
});
