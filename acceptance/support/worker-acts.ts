import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commandLine, type DimResult, quote, resultOf } from "./dim-output";
import { OrderView } from "./order-view";
import { unreachable } from "./unreachable";

const Slice = z.strictObject({ title: z.string(), outcome: z.string() });

export type Slice = z.infer<typeof Slice>;

const Finding = z.strictObject({
  area: z.string(),
  file: z.string(),
  line: z.number(),
  failure: z.string(),
  fix: z.string(),
  severity: z.enum(["critical", "high", "medium"]),
});

export type Finding = z.infer<typeof Finding>;

const ReviewArtifact = z.strictObject({
  body: z.string(),
  covered: z.array(z.string()).readonly(),
  setAside: z.array(z.string()).readonly(),
  unverified: z.array(z.string()).readonly(),
});

export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

export const WorkerAct = z.discriminatedUnion("act", [
  z.strictObject({ act: z.literal("plan"), body: z.string(), slices: z.array(Slice).readonly() }),
  z.strictObject({ act: z.literal("order-return"), reason: z.string() }),
  z.strictObject({ act: z.literal("commit"), subject: z.string() }),
  z.strictObject({
    act: z.literal("answer"),
    file: z.string(),
    line: z.number(),
    answer: z.enum(["fixed", "refused"]),
    reason: z.string(),
  }),
  z.strictObject({ act: z.literal("build-return"), artifact: z.string() }),
  z.strictObject({ act: z.literal("findings"), findings: z.array(Finding).readonly() }),
  z.strictObject({ act: z.literal("review-return"), artifact: ReviewArtifact }),
  z.strictObject({ act: z.literal("message"), text: z.string(), to: z.string().nullable() }),
  z.strictObject({ act: z.literal("dim"), args: z.array(z.string()).readonly() }),
]);

export type WorkerAct = z.infer<typeof WorkerAct>;

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
      return ["message", "send", act.text, ...(act.to === null ? [] : ["--to", act.to])];
    case "dim":
      return act.args;
    default:
      return unreachable(act);
  }
}
