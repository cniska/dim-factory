import type { StationRole } from "./vocabulary";
import type { WorkerAct } from "./worker-acts";

export type HarnessAct =
  | WorkerAct
  | { readonly act: "sh"; readonly command: string }
  | { readonly act: "write"; readonly path: string; readonly content: string }
  | { readonly act: "say"; readonly text: string }
  | { readonly act: "signal"; readonly name: string }
  | { readonly act: "wait"; readonly name: string }
  | { readonly act: "build-remaining"; readonly artifact: string }
  | { readonly act: "die" }
  | { readonly act: "limit"; readonly resetsAt: string };

export type HarnessTurn = readonly HarnessAct[];

export type HarnessScript = Readonly<Partial<Record<StationRole, readonly HarnessTurn[]>>>;

export const ORDER_PLACEHOLDER = "{order}";

export const TMPDIR_PLACEHOLDER = "{tmpdir}";
