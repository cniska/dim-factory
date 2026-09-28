#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { REVIEW_DIMENSIONS } from "../src/station-review-artifact";

const BUILD_ARTIFACT = [
  "## Outcome",
  "The requested change is implemented across both slices.",
  "## Implementation",
  "Each slice wrote the file its outcome names.",
  "## Why this shape",
  "The scripted builder writes one file per slice, so every slice leaves a commit to trace.",
  "## Verification",
  "Both slices recorded passing checks.",
  "## Owner attention",
  "Nothing needs the owner.",
].join("\n\n");

const REVIEW = {
  verdict: "No findings; the change is ready to advance.",
  findings: [],
  conformance: [],
  coverage: REVIEW_DIMENSIONS.map((dimension) => ({ dimension, status: "clean", reason: null })),
  set_aside: [],
  unverified: [],
  observations: [],
};

function sandbox(args: string[]): never {
  const command = args.slice(args.indexOf("--") + 1);
  if (command.join(" ").includes("check-canary-")) process.exit(1);
  process.exit(Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1);
}

function turn(brief: string, order: string): unknown {
  if (brief.includes("planner")) {
    return {
      body: "## Outcome\n\nBuild the requested result.",
      slices: [
        { title: "First slice", outcome: "The first slice is verified." },
        { title: "Second slice", outcome: "The second slice is verified." },
      ],
    };
  }
  if (brief.includes("builder")) {
    const slice = /# Current slice\s+(\d+)\./.exec(brief)?.[1] ?? "1";
    writeFileSync(`built-by-scripted-harness-${slice}.txt`, `${order} slice ${slice}\n`);
    return {
      subject: `feat: scripted harness slice ${slice}`,
      artifact: slice === "2" ? BUILD_ARTIFACT : "",
      answers: [],
    };
  }
  if (brief.includes("reviewer")) return REVIEW;
  process.exit(4);
}

const args = Bun.argv.slice(2);
if (args[0] === "sandbox") sandbox(args);
const brief = args.find((arg) => arg.includes("factory order ")) ?? "";
const order = /factory order ([^\s]+)/.exec(brief)?.[1];
if (!order) process.exit(2);
const role = brief.includes("planner") ? "planner" : brief.includes("builder") ? "builder" : "reviewer";
const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: `harness-${role}-${order}` });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(turn(brief, order)) } });
emit({ type: "turn.completed" });
