import { refuser } from "./coded-error";
import type { Policy } from "./station";

export type SessionStart =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string };

export type Start = {
  readonly session: SessionStart;
  readonly model: string;
  readonly policy: Policy;
  readonly socket: string;
};

export type Adapter = {
  readonly signIn: readonly string[];
  argv(start: Start): readonly string[];
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
