import type { Grader } from "./grader-contract";
import { noRefusedShell } from "./graders/no-refused-shell";
import { planFileWritten } from "./graders/plan-file-written";

export const GRADERS = {
  "no-refused-shell": noRefusedShell,
  "plan-file-written": planFileWritten,
} as const satisfies Record<string, Grader>;

export type GraderName = keyof typeof GRADERS;
