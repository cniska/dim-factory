import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commandLine, refusal, resultOf } from "./support/dim-output";
import { CHECKOUT, type Machine, machines } from "./support/machine";

const start = machines();

const Installed = z.strictObject({
  gates: z.array(z.string()),
  written: z.array(z.string()),
  removed: z.array(z.string()),
  backups: z.array(z.string()),
  format: z
    .strictObject({
      command: z.string(),
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      output: z.string(),
    })
    .nullable(),
});

const Health = z.strictObject({
  name: z.string(),
  state: z.string(),
  detail: z.string(),
  fix: z.string().optional(),
});

const Diagnosed = z.strictObject({
  command: z.literal("doctor"),
  ok: z.boolean(),
  result: z.strictObject({ checks: z.array(Health), failing: z.number() }),
});

const BEHIND = "#!/bin/sh\n# dim-gate:0\nexit 0\n";
const OWN_HOOK = "#!/bin/sh\nexit 0\n";

const install = (m: Machine, ...gates: string[]) => m.operator.dim(["gates", "install", ...gates], Installed);

function commitWithoutDim(m: Machine, subject: string): number {
  const path = (process.env.PATH ?? "").split(":").filter((dir) => dir !== m.bin);
  m.git(["add", "-A"]);
  return Bun.spawnSync(["git", "commit", "-q", "-m", subject], {
    cwd: m.repo,
    env: { PATH: path.join(":"), HOME: m.home },
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

const tree = (m: Machine) => m.git(["status", "--porcelain", "--untracked-files=all"]);

async function doctor(m: Machine): Promise<Readonly<Record<string, z.infer<typeof Health>>>> {
  const ran = await m.operator.sh(commandLine(["doctor"]));
  if (ran.stdout.trim() === "") throw new Error(`dim doctor printed nothing:\n${ran.stderr}`);
  const { checks } = Diagnosed.parse(JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "")).result;
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

describe("adopting a project", () => {
  test("AC-79 a TypeScript project with every gate chosen refuses a long subject, a failing check and a comment with no dim on the path", async () => {
    const passing = await start();
    resultOf(await install(passing, "commit-subject", "check", "no-comments"));
    writeFileSync(join(passing.repo, "greeting.ts"), "export const greeting = 'hello';\n");
    expect(
      commitWithoutDim(passing, "feat: add a greeting that runs on far past the fifty character limit"),
    ).not.toBe(0);
    writeFileSync(join(passing.repo, "greeting.ts"), "export const greeting = 'hello'; // why\n");
    expect(commitWithoutDim(passing, "feat: add a greeting")).not.toBe(0);
    writeFileSync(join(passing.repo, "greeting.ts"), "export const greeting = 'hello';\n");
    expect(commitWithoutDim(passing, "feat: add a greeting")).toBe(0);

    const failing = await start({ check: "false" });
    resultOf(await install(failing, "commit-subject", "check", "no-comments"));
    writeFileSync(join(failing.repo, "greeting.ts"), "export const greeting = 'hello';\n");
    expect(commitWithoutDim(failing, "feat: add a greeting")).not.toBe(0);
  });

  test("AC-79 choosing the comment ban in a project with no code it reads is refused and writes nothing", async () => {
    const m = await start();
    m.git(["rm", "-q", "-r", "package.json", "bun.lock", "vendor"]);
    const before = tree(m);
    expect(refusal(await install(m, "commit-subject", "no-comments")).code).toBe("no_ecosystem");
    expect(tree(m)).toBe(before);
  });

  test("AC-79 installing with no choice made, outside a terminal, is refused and writes nothing", async () => {
    const m = await start();
    const before = tree(m);
    expect(refusal(await install(m)).code).toBe("no_gates_chosen");
    expect(tree(m)).toBe(before);
  });

  test("AC-80 installing again changes nothing, a gate behind is replaced alone, and a dropped gate alone is removed", async () => {
    const m = await start();
    resultOf(await install(m, "commit-subject", "check"));
    writeFileSync(join(m.repo, ".githooks", "pre-push"), OWN_HOOK);

    expect(resultOf(await install(m))).toEqual({
      gates: ["commit-subject", "check"],
      written: [],
      removed: [],
      backups: [],
      format: null,
    });

    writeFileSync(join(m.repo, ".githooks", "commit-msg"), BEHIND);
    expect(resultOf(await install(m)).written).toEqual([".githooks/commit-msg"]);
    expect(readFileSync(join(m.repo, ".githooks", "commit-msg"), "utf8")).toBe(
      readFileSync(join(CHECKOUT, "gates", "commit-msg"), "utf8"),
    );

    expect(resultOf(await install(m, "commit-subject"))).toMatchObject({
      written: [],
      removed: [".githooks/pre-commit", ".githooks/pre-commit.d/check", ".github/workflows/check.yml"],
    });
    expect(readFileSync(join(m.repo, ".githooks", "pre-push"), "utf8")).toBe(OWN_HOOK);
  });

  test("AC-81 dim doctor reports each unmet gate and a missing ship setting with what resolves it, changing nothing", async () => {
    const m = await start();
    m.projectSettings({});
    resultOf(await install(m, "commit-subject", "check"));
    writeFileSync(join(m.repo, ".githooks", "commit-msg"), BEHIND);
    rmSync(join(m.repo, ".github"), { recursive: true });
    writeFileSync(
      join(m.repo, ".githooks", "pre-commit"),
      `${readFileSync(join(m.repo, ".githooks", "pre-commit"), "utf8")}true\n`,
    );
    await m.operator.sh(commandLine(["sync"]));
    const before = tree(m);
    const record = readFileSync(join(m.record, "sessions.db"));

    const first = await doctor(m);

    expect(first.gates).toMatchObject({
      state: "fail",
      detail:
        ".githooks/commit-msg behind; .github/workflows/commits.yml missing; .githooks/pre-commit changed; .github/workflows/check.yml missing",
      fix: `dim gates install, from ${realpathSync(m.repo)}`,
    });
    expect(first.ship).toMatchObject({ state: "fail", fix: expect.stringContaining("dim config set ship") });
    expect(tree(m)).toBe(before);
    expect(readFileSync(join(m.record, "sessions.db")).equals(record)).toBe(true);

    resultOf(await install(m));
    writeFileSync(join(m.repo, ".dim", "config.json"), '{ "gates": ["commit-subject"] }\n');
    expect((await doctor(m)).gates?.detail).toBe(
      ".githooks/pre-commit unchosen; .githooks/pre-commit.d/check unchosen; .github/workflows/check.yml unchosen",
    );
  });
});
