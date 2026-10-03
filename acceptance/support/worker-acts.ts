import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { commandLine, type DimResult, quote, resultOf } from "./dim-output";
import { OrderView } from "./order-view";
import { unreachable } from "./unreachable";

export type Slice = { readonly title: string; readonly outcome: string };

export type Finding = {
  readonly area: string;
  readonly file: string;
  readonly line: number;
  readonly failure: string;
  readonly fix: string;
  readonly severity: "critical" | "high" | "medium";
};

export type ReviewArtifact = {
  readonly body: string;
  readonly covered: readonly string[];
  readonly setAside: readonly string[];
  readonly unverified: readonly string[];
};

export type WorkerAct =
  | { readonly act: "plan"; readonly body: string; readonly slices: readonly Slice[] }
  | { readonly act: "order-return"; readonly reason: string }
  | { readonly act: "commit"; readonly subject: string }
  | {
      readonly act: "answer";
      readonly file: string;
      readonly line: number;
      readonly answer: "fixed" | "refused";
      readonly reason: string;
    }
  | { readonly act: "build-return"; readonly artifact: string }
  | { readonly act: "findings"; readonly findings: readonly Finding[] }
  | { readonly act: "review-return"; readonly artifact: ReviewArtifact }
  | { readonly act: "message"; readonly text: string; readonly to?: string }
  | { readonly act: "dim"; readonly args: readonly string[] };

const WORKER_ACTS: Readonly<Record<WorkerAct["act"], true>> = {
  plan: true,
  "order-return": true,
  commit: true,
  answer: true,
  "build-return": true,
  findings: true,
  "review-return": true,
  message: true,
  dim: true,
};

export function isWorkerAct(act: { readonly act: string }): act is WorkerAct {
  return Object.hasOwn(WORKER_ACTS, act.act);
}

export type Dim = <T>(args: readonly string[], schema: z.ZodType<T>) => DimResult<T>;

function written(scratch: string, name: string, body: string): string {
  const path = join(scratch, `${crypto.randomUUID()}-${name}`);
  writeFileSync(path, body);
  return path;
}

function findingId(dim: Dim, file: string, line: number): string {
  const found = resultOf(dim(["order", "show"], OrderView)).findings.find(
    (finding) => finding.file === file && finding.line === line,
  );
  if (!found) throw new Error(`no finding at ${file}:${line} on this worker's order`);
  return found.id;
}

export function workerCommand(act: WorkerAct, dim: Dim, scratch: string): string {
  if (act.act === "commit") {
    return `git add -A && git commit -q -m ${quote(act.subject)} && ${commandLine(["slice", "submit"])}`;
  }
  return commandLine(dimArgs(act, dim, scratch));
}

function dimArgs(
  act: Exclude<WorkerAct, { readonly act: "commit" }>,
  dim: Dim,
  scratch: string,
): readonly string[] {
  switch (act.act) {
    case "plan":
      return [
        "plan",
        "return",
        written(scratch, "plan.json", JSON.stringify({ body: act.body, slices: act.slices })),
      ];
    case "order-return":
      return ["order", "return", "--reason", act.reason];
    case "answer":
      return ["finding", "answer", findingId(dim, act.file, act.line), act.answer, "--reason", act.reason];
    case "build-return":
      return ["build", "return", written(scratch, "build.md", act.artifact)];
    case "findings":
      return [
        "review",
        "return",
        "--findings",
        written(scratch, "findings.json", JSON.stringify(act.findings)),
      ];
    case "review-return":
      return [
        "review",
        "return",
        "--artifact",
        written(scratch, "review.json", JSON.stringify(act.artifact)),
      ];
    case "message":
      return ["message", "send", act.text, ...(act.to === undefined ? [] : ["--to", act.to])];
    case "dim":
      return act.args;
    default:
      return unreachable(act);
  }
}
