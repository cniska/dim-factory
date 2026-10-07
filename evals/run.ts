import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Case, caseAt } from "./case";
import type { Verdict } from "./grader-contract";
import { toolCallsOf } from "./transcript";

const REPO = resolve(import.meta.dir, "..");
const CASES = join(import.meta.dir, "cases");
const RESULTS = join(import.meta.dir, "results");
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

type Arm = "without" | "with";

type Scored = { readonly arm: Arm; readonly run: number; readonly verdicts: readonly Verdict[] };

function settingsFor(tmp: string): string {
  return JSON.stringify({
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: [tmp] } },
    permissions: { allow: [`Edit(/${tmp}/**)`] },
  });
}

function runOnce(spec: Case, arm: Arm, run: number, token: string, out: string): Scored {
  const root = mkdtempSync(join(tmpdir(), "dim-eval-"));
  try {
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    const workspace = join(root, "workspace");
    for (const dir of [home, tmp, workspace]) mkdirSync(dir, { recursive: true });
    const env = { ...process.env, HOME: home, TMPDIR: tmp, WORKSPACE: workspace, CLAUDE_CODE_OAUTH_TOKEN: token };
    const scaffold = Bun.spawnSync(["sh", join(spec.dir, "scaffold.sh")], { env, stderr: "pipe" });
    if (scaffold.exitCode !== 0) throw new Error(`${spec.name} scaffold failed: ${scaffold.stderr.toString()}`);
    const instruction = arm === "with" ? ["--append-system-prompt", readFileSync(join(REPO, spec.instruction), "utf8")] : [];
    const ran = Bun.spawnSync(
      [
        "claude",
        "-p",
        spec.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        spec.model,
        "--permission-mode",
        "acceptEdits",
        "--setting-sources",
        "user",
        "--tools",
        spec.tools,
        "--settings",
        settingsFor(tmp),
        ...instruction,
      ],
      { cwd: workspace, env, stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS },
    );
    const transcript = ran.stdout.toString();
    const dir = join(out, arm, String(run));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.jsonl"), transcript);
    const graded = { toolCalls: toolCallsOf(transcript.split("\n")), workspace, tmp };
    return { arm, run, verdicts: spec.graders.map((grader) => grader.grade(graded)) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function passed(scored: Scored): boolean {
  return scored.verdicts.every((verdict) => verdict.pass);
}

function main(): number {
  const [name, ...flags] = Bun.argv.slice(2);
  if (name === undefined) throw new Error("usage: bun run eval <case> [--runs <n>]");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token === undefined || token === "")
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set; each run signs claude in with it");
  const spec = caseAt(CASES, name);
  const runsFlag = flags.indexOf("--runs");
  const runs = runsFlag === -1 ? spec.runs : Number(flags[runsFlag + 1]);
  const out = join(RESULTS, `${new Date().toISOString().replaceAll(":", "-")}-${name}`);
  const scored: Scored[] = [];
  for (const arm of ["without", "with"] as const) {
    for (let run = 1; run <= runs; run += 1) {
      const result = runOnce(spec, arm, run, token, out);
      scored.push(result);
      console.log(
        `${arm} ${run}: ${passed(result) ? "pass" : "fail"}  ${result.verdicts.map((v, i) => `${spec.graders[i]?.name}=${v.pass ? "pass" : `fail (${v.reason})`}`).join("  ")}`,
      );
    }
  }
  const rate = (arm: Arm) => scored.filter((one) => one.arm === arm && passed(one)).length;
  console.log(`${name}: without ${rate("without")}/${runs}, with ${rate("with")}/${runs}; transcripts in ${out}`);
  if (rate("without") === runs) {
    console.log(`${name} measures nothing: the without side passed every run`);
    return 1;
  }
  return 0;
}

process.exit(main());
