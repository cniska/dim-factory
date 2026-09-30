import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Slice = { title: string; outcome: string };

export type Finding = {
  area: string;
  file: string;
  line: number;
  failure: string;
  fix: string;
  severity: "critical" | "high" | "medium";
};

export type ReviewArtifact = { body: string; covered: string[]; setAside: string[]; unverified: string[] };

export type WorkerAct =
  | { act: "plan"; body: string; slices: Slice[] }
  | { act: "cannot-plan"; reason: string }
  | { act: "commit"; subject: string }
  | { act: "answer"; file: string; line: number; answer: "fixed" | "refused"; reason: string }
  | { act: "build-return"; artifact: string }
  | { act: "findings"; findings: Finding[] }
  | { act: "review-return"; artifact: ReviewArtifact }
  | { act: "send-back"; reason: string }
  | { act: "message"; text: string; to?: string }
  | { act: "dim"; args: string[] };

type OpenFinding = { id: string; file: string; line: number };

export type Dim = (args: string[]) => { exitCode: number; stdout: string; stderr: string };

function written(scratch: string, name: string, body: string): string {
  const path = join(scratch, `${crypto.randomUUID()}-${name}`);
  writeFileSync(path, body);
  return path;
}

function findingId(dim: Dim, file: string, line: number): string {
  const shown = JSON.parse(dim(["order", "show"]).stdout) as { result?: { findings?: OpenFinding[] } };
  const found = shown.result?.findings?.find((finding) => finding.file === file && finding.line === line);
  if (!found) throw new Error(`no finding at ${file}:${line} on this worker's order`);
  return found.id;
}

export function dimArgs(act: WorkerAct, dim: Dim, scratch: string): string[] {
  switch (act.act) {
    case "plan":
      return [
        "plan",
        "return",
        written(scratch, "plan.json", JSON.stringify({ body: act.body, slices: act.slices })),
      ];
    case "cannot-plan":
    case "send-back":
      return ["order", "return", "--reason", act.reason];
    case "commit":
      return ["slice", "commit", "--subject", act.subject];
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
      return ["message", "send", act.text, ...(act.to ? ["--to", act.to] : [])];
    case "dim":
      return act.args;
  }
}
