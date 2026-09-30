import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Machine, type MachineOptions, newMachine } from "./support/machine";
import {
  addOrder,
  approve,
  returnArtifact,
  reviseOrder,
  runOrder,
  shipThrough,
  showOrder,
} from "./support/operator-acts";
import { actions, type OrderView } from "./support/order-view";
import type { HarnessScript, HarnessTurn, Invocation } from "./support/scripted-harness-state";
import {
  BUILD_ARTIFACT,
  buildTurn,
  finding,
  findingsTurn,
  happyPath,
  planTurn,
  REVIEW_ARTIFACT,
  reviewTurn,
  SLICES,
  sliceActs,
} from "./support/scripts";
import { ACTION, NEXT } from "./support/vocabulary";

setDefaultTimeout(180_000);

let machine: Machine;
afterEach(() => machine?.close());

async function scripted(script: HarnessScript, options: MachineOptions = {}): Promise<Machine> {
  machine = await newMachine(options);
  machine.script(script);
  return machine;
}

const briefsOf = (m: Machine, role: Invocation["role"]) =>
  m
    .invocations()
    .filter((call) => call.role === role)
    .map((call) => call.prompt);

async function planned(m: Machine, fields: Parameters<typeof addOrder>[1] = {}): Promise<string> {
  const id = await addOrder(m.operator, fields);
  await runOrder(m.operator, id);
  return id;
}

async function built(m: Machine): Promise<string> {
  const id = await planned(m);
  await approve(m.operator, id);
  return id;
}

const branchSubjects = (m: Machine, order: OrderView) =>
  m
    .git(["log", "--reverse", "--format=%s", `main..${order.branch}`])
    .split("\n")
    .filter(Boolean);

describe("briefs", () => {
  test("each station's brief is a fixed set of fields that names its skill", async () => {
    const m = await scripted({
      planner: [planTurn(), planTurn()],
      builder: [buildTurn(), buildTurn()],
      reviewer: [reviewTurn(), reviewTurn()],
    });
    await shipThrough(m.operator, await addOrder(m.operator, { title: "First" }));
    await shipThrough(
      m.operator,
      await addOrder(m.operator, { title: "Second", request: "Add a farewell to the README." }),
    );

    for (const [role, skill] of [
      ["planner", "dim-plan"],
      ["builder", "dim-build"],
      ["reviewer", "dim-review"],
    ] as const) {
      const [first, second] = briefsOf(m, role).map((brief) => JSON.parse(brief) as Record<string, unknown>);
      expect(first?.skill).toBe(skill);
      expect(Object.keys(first ?? {}).sort()).toEqual(Object.keys(second ?? {}).sort());
    }
  });

  test("no sentence of a brief repeats in every order's brief", async () => {
    const m = await scripted({
      planner: [planTurn(), planTurn()],
      builder: [buildTurn(), buildTurn()],
      reviewer: [reviewTurn(), reviewTurn()],
    });
    await shipThrough(m.operator, await addOrder(m.operator, { title: "First" }));
    await shipThrough(
      m.operator,
      await addOrder(m.operator, { title: "Second", request: "Add a farewell to the README." }),
    );

    const sentences = (brief: string) =>
      Object.entries(JSON.parse(brief) as Record<string, unknown>)
        .filter(([field]) => field !== "skill")
        .flatMap(([, value]) => JSON.stringify(value).split(/(?<=[.!?])\s+/))
        .filter((sentence) => sentence.length > 20);
    for (const role of ["planner", "builder", "reviewer"] as const) {
      const [first, second] = briefsOf(m, role).map(sentences);
      expect((first ?? []).filter((sentence) => second?.includes(sentence))).toEqual([]);
    }
  });

  test("the planner is briefed with the request, the builder with the approved plan, the reviewer with the Build artifact and the diff", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator, { request: "Add a greeting to the README, please." });
    await shipThrough(m.operator, id);

    expect(briefsOf(m, "planner")[0]).toContain("Add a greeting to the README, please.");
    for (const slice of SLICES) expect(briefsOf(m, "builder")[0]).toContain(slice.title);
    expect(briefsOf(m, "reviewer")[0]).toContain("The README links a greeting.");
    expect(briefsOf(m, "reviewer")[0]).toContain("slice-2.txt");
  });

  test("each recorded slice of a plan has a title and an outcome", async () => {
    const m = await scripted(happyPath());
    const order = await showOrder(m.operator, await planned(m));
    expect(order.slices.map(({ title, outcome }) => ({ title, outcome }))).toEqual(SLICES);
  });

  test("a revised request briefs the next plan", async () => {
    const m = await scripted({ planner: [[{ act: "cannot-plan", reason: "which README?" }], planTurn()] });
    const id = await planned(m);

    expect((await reviseOrder(m.operator, id, "Add a greeting to the top-level README.")).ok).toBe(true);
    await runOrder(m.operator, id);

    expect(briefsOf(m, "planner")[1]).toContain("Add a greeting to the top-level README.");
    expect((await showOrder(m.operator, id)).next).toBe(NEXT.approve);
  });
});

describe("what a station worker may change", () => {
  test("a planner's writes to the worktree and the record are refused and its plan comes only from its return", async () => {
    const m = await scripted({
      planner: [
        [
          { act: "write", path: "planted-by-write.txt", content: "x\n" },
          { act: "sh", command: "echo x > planted-by-shell.txt" },
          { act: "sh", command: 'touch "$DIM_HOME/planted"' },
          ...planTurn(),
        ],
      ],
    });
    const order = await showOrder(m.operator, await planned(m));

    expect(existsSync(join(order.worktree, "planted-by-write.txt"))).toBe(false);
    expect(existsSync(join(order.worktree, "planted-by-shell.txt"))).toBe(false);
    expect(existsSync(join(m.env.DIM_HOME as string, "planted"))).toBe(false);
    expect(actions(order).filter((action) => action === ACTION.planReturned)).toHaveLength(1);
  });

  test("a reviewer's writes to the worktree and the record are refused", async () => {
    const m = await scripted({
      ...happyPath(),
      reviewer: [
        [
          { act: "write", path: "planted.txt", content: "x\n" },
          { act: "sh", command: 'echo x > planted-by-shell.txt; touch "$DIM_HOME/planted"' },
          ...reviewTurn(),
        ],
      ],
    });
    const id = await built(m);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(existsSync(join(order.worktree, "planted.txt"))).toBe(false);
    expect(existsSync(join(order.worktree, "planted-by-shell.txt"))).toBe(false);
    expect(existsSync(join(m.env.DIM_HOME as string, "planted"))).toBe(false);
  });
});

describe("slice gates", () => {
  const oneSlice = (acts: HarnessTurn): HarnessScript => ({
    planner: [planTurn([{ title: "One", outcome: "One file." }])],
    builder: [[...acts, { act: "build-return", artifact: BUILD_ARTIFACT }]],
  });

  test("a slice with a comment, an unchanged test and an unusual subject is kept when the check passes", async () => {
    const m = await scripted(
      oneSlice([
        { act: "write", path: "greet.ts", content: "// says hello\nexport const greet = 'hello';\n" },
        { act: "commit", subject: "wip!! greeting, see thread" },
      ]),
    );
    const order = await showOrder(m.operator, await built(m));

    expect(branchSubjects(m, order)).toEqual(["wip!! greeting, see thread"]);
    expect(order.next).toBe(NEXT.approve);
  });

  const refusedCases: [string, MachineOptions, HarnessTurn][] = [
    [
      "whose check fails",
      { check: "echo RED-CHECK-OUTPUT; [ ! -e red.txt ]" },
      [{ act: "write", path: "red.txt", content: "x\n" }],
    ],
    [
      "whose check rewrote files",
      { check: "[ ! -e rewrite-me.txt ] || echo rewritten >> rewrite-me.txt" },
      [{ act: "write", path: "rewrite-me.txt", content: "x\n" }],
    ],
    [
      "that changed the check's definition",
      { check: "[ ! -e red.txt ]" },
      [
        { act: "write", path: "red.txt", content: "x\n" },
        { act: "write", path: "package.json", content: '{"scripts":{"verify":"true"}}\n' },
      ],
    ],
    [
      "whose commit is not on the recorded head of the order's branch",
      {},
      [
        { act: "write", path: "one.txt", content: "x\n" },
        { act: "signal", name: "before-commit" },
        { act: "wait", name: "branch-moved" },
      ],
    ],
  ];

  for (const [name, options, acts] of refusedCases) {
    test(`a slice ${name} is refused and leaves the order's branch as it was`, async () => {
      const m = await scripted(oneSlice([...acts, { act: "commit", subject: "feat: add one" }]), options);
      const id = await planned(m);
      const building = approve(m.operator, id);
      if (name.includes("recorded head")) {
        await m.reached("before-commit");
        const { worktree } = await showOrder(m.operator, id);
        m.git(["commit", "-q", "--allow-empty", "-m", "chore: the owner moves the branch"], worktree);
        m.release("branch-moved");
      }
      await building;

      const order = await showOrder(m.operator, id);
      expect(actions(order)).toContain(ACTION.sliceRefused);
      expect(actions(order)).not.toContain(ACTION.sliceCommitted);
      expect(branchSubjects(m, order)).not.toContain("feat: add one");
    });
  }

  test("a refused slice's log entry carries the check's output", async () => {
    const m = await scripted(
      oneSlice([
        { act: "write", path: "red.txt", content: "x\n" },
        { act: "commit", subject: "feat: add red" },
      ]),
      { check: "echo RED-CHECK-OUTPUT; [ ! -e red.txt ]" },
    );
    const order = await showOrder(m.operator, await built(m));

    const refused = order.log.find((entry) => entry.action === ACTION.sliceRefused);
    expect(refused?.code).toBeString();
    expect(JSON.stringify(refused?.evidence)).toContain("RED-CHECK-OUTPUT");
  });

  test("one build commits each slice in order through the gates and returns once", async () => {
    const m = await scripted(happyPath());
    const order = await showOrder(m.operator, await built(m));

    expect(briefsOf(m, "builder")).toHaveLength(1);
    expect(branchSubjects(m, order)).toEqual(["feat: add slice 1", "feat: add slice 2"]);
    const build = actions(order).filter((action) =>
      [ACTION.sliceCommitted, ACTION.buildReturned].includes(action as never),
    );
    expect(build).toEqual([ACTION.sliceCommitted, ACTION.sliceCommitted, ACTION.buildReturned]);
  });
});

describe("definitions of done", () => {
  test("a plan with no slice records nothing and goes back to the planner, whose corrected plan is accepted", async () => {
    const m = await scripted({ planner: [[...planTurn([]), ...planTurn()]] });
    const order = await showOrder(m.operator, await planned(m));

    expect(briefsOf(m, "planner")).toHaveLength(1);
    expect(actions(order).filter((action) => action === ACTION.planReturned)).toHaveLength(1);
    expect(order.slices).toHaveLength(2);
    expect(order.next).toBe(NEXT.approve);
  });

  test("a second return that misses the definition of done fails the station for the operator", async () => {
    const m = await scripted({ planner: [[...planTurn([]), ...planTurn([])]] });
    const id = await addOrder(m.operator);

    const ran = await runOrder(m.operator, id);

    expect(ran.ok).toBe(false);
    const order = await showOrder(m.operator, id);
    expect(actions(order)).not.toContain(ACTION.planReturned);
    expect(actions(order)).toContain(ACTION.stationFailed);
  });

  test("a slice commit with no subject line records nothing and the builder's corrected commit is kept", async () => {
    const m = await scripted({
      planner: [planTurn([{ title: "One", outcome: "One file." }])],
      builder: [
        [
          { act: "write", path: "one.txt", content: "x\n" },
          { act: "commit", subject: "" },
          { act: "commit", subject: "feat: add one" },
          { act: "build-return", artifact: BUILD_ARTIFACT },
        ],
      ],
    });
    const order = await showOrder(m.operator, await built(m));

    expect(branchSubjects(m, order)).toEqual(["feat: add one"]);
    expect(order.next).toBe(NEXT.approve);
  });

  test("a review finding with no file records nothing and the reviewer's corrected findings are accepted", async () => {
    const m = await scripted({
      ...happyPath(),
      reviewer: [[...findingsTurn([{ ...finding(), file: "" }]), ...findingsTurn([finding()])]],
    });
    const id = await built(m);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.findings.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "slice-1.txt", line: 1 },
    ]);
    expect(order.station).toBe("build");
  });

  test("a build with an uncommitted slice does not hand over", async () => {
    const m = await scripted({
      planner: [planTurn()],
      builder: [[...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
    });
    const id = await planned(m);

    const ran = await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(ran.ok).toBe(false);
    expect(actions(order)).not.toContain(ACTION.buildReturned);
    expect(order.next).toBe(NEXT.run);
  });

  test("every artifact a station hands over waits for approval", async () => {
    const m = await scripted(happyPath());
    const id = await addOrder(m.operator);
    for (const station of ["plan", "build", "review"] as const) {
      const ran = station === "plan" ? await runOrder(m.operator, id) : await approve(m.operator, id);
      expect(ran.ok).toBe(true);
      const order = await showOrder(m.operator, id);
      expect([order.station, order.next]).toEqual([station, NEXT.approve]);
    }
  });

  test("a Review artifact that does not say which areas it covered is refused", async () => {
    const m = await scripted({
      ...happyPath(),
      reviewer: [
        [
          { act: "review-return", artifact: { ...REVIEW_ARTIFACT, covered: [] } },
          { act: "review-return", artifact: { ...REVIEW_ARTIFACT, covered: [] } },
        ],
      ],
    });
    const id = await built(m);

    const ran = await approve(m.operator, id);

    expect(ran.ok).toBe(false);
    expect(actions(await showOrder(m.operator, id))).not.toContain(ACTION.reviewReturned);
  });
});

describe("review findings", () => {
  const reviewedWithFinding = (
    builderAnswer: HarnessTurn,
    reviewer2: HarnessTurn = reviewTurn(),
  ): HarnessScript => ({
    planner: [planTurn()],
    builder: [buildTurn(), builderAnswer],
    reviewer: [findingsTurn([finding()]), reviewer2],
  });

  async function atFindings(m: Machine): Promise<string> {
    const id = await built(m);
    await approve(m.operator, id);
    return id;
  }

  test("findings put the order at build, where the builder's fix passes the slice gates and answers each finding once", async () => {
    const m = await scripted(
      reviewedWithFinding([
        { act: "write", path: "slice-1.txt", content: "hello\n" },
        { act: "commit", subject: "fix: say hello" },
        { act: "answer", file: "slice-1.txt", line: 1, answer: "fixed", reason: "it says hello now" },
        { act: "build-return", artifact: BUILD_ARTIFACT },
      ]),
    );
    const id = await atFindings(m);
    expect((await showOrder(m.operator, id)).station).toBe("build");

    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.findings[0]?.answer).toBe("fixed");
    expect(branchSubjects(m, order).at(-1)).toBe("fix: say hello");
    expect(order.next).toBe(NEXT.approve);
    await approve(m.operator, id);
    expect(briefsOf(m, "reviewer")[1]).toContain("it says hello now");
  });

  test("a build turn that leaves a finding unanswered is refused", async () => {
    const m = await scripted(reviewedWithFinding([{ act: "build-return", artifact: BUILD_ARTIFACT }]));
    const id = await atFindings(m);

    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.findings[0]?.answer).toBeUndefined();
    expect(actions(order).filter((action) => action === ACTION.buildReturned)).toHaveLength(1);
  });

  test("a finding answered twice is refused the second time", async () => {
    const answer = { act: "answer", file: "slice-1.txt", line: 1, reason: "it holds" } as const;
    const m = await scripted(
      reviewedWithFinding([
        { ...answer, answer: "refused" },
        { ...answer, answer: "fixed" },
        { act: "build-return", artifact: BUILD_ARTIFACT },
      ]),
    );
    const id = await atFindings(m);
    await runOrder(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.findings[0]?.answer).toBe("refused");
    expect(actions(order).filter((action) => action === ACTION.findingAnswered)).toHaveLength(1);
  });

  test("a finding the builder refused and the next review raised again stops the order for the operator", async () => {
    const m = await scripted(
      reviewedWithFinding(
        [
          {
            act: "answer",
            file: "slice-1.txt",
            line: 1,
            answer: "refused",
            reason: "the file name is the point",
          },
          { act: "build-return", artifact: BUILD_ARTIFACT },
        ],
        findingsTurn([finding()]),
      ),
    );
    const id = await atFindings(m);
    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.next).toBe(NEXT.decide);
    expect((await runOrder(m.operator, id)).ok).toBe(false);
  });
});

describe("going back to plan", () => {
  test("slices committed before a builder's return to plan stay, and the revised plan decides which stay", async () => {
    const m = await scripted({
      planner: [
        planTurn([...SLICES, { title: "Third", outcome: "A third file." }]),
        planTurn([
          { title: "Keep the first, drop the second", outcome: "slice-2.txt is gone." },
          { title: "Third", outcome: "A third file." },
        ]),
      ],
      builder: [
        [
          ...sliceActs(1),
          ...sliceActs(2),
          { act: "send-back", reason: "the third slice needs the second gone" },
        ],
        [
          { act: "sh", command: "rm slice-2.txt" },
          { act: "commit", subject: "refactor: drop slice 2" },
          ...sliceActs(3),
          { act: "build-return", artifact: BUILD_ARTIFACT },
        ],
      ],
      reviewer: [reviewTurn()],
    });
    const id = await built(m);
    const sentBack = await showOrder(m.operator, id);
    expect(sentBack.station).toBe("plan");
    expect(branchSubjects(m, sentBack)).toEqual(["feat: add slice 1", "feat: add slice 2"]);

    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    const onMain = m.git(["ls-tree", "--name-only", "main"]).split("\n");
    expect(onMain).toContain("slice-1.txt");
    expect(onMain).toContain("slice-3.txt");
    expect(onMain).not.toContain("slice-2.txt");
  });
});

describe("the operator's decisions", () => {
  test("a returned Build artifact runs the same builder again, briefed with the reason", async () => {
    const m = await scripted({
      planner: [planTurn()],
      builder: [buildTurn(), [{ act: "build-return", artifact: `${BUILD_ARTIFACT}\n\nRevised.` }]],
    });
    const id = await built(m);

    await returnArtifact(m.operator, id, "say which check ran");

    const builders = m.invocations().filter((call) => call.role === "builder");
    expect(builders[1]?.resumed).toBe(builders[0]?.sessionId as string);
    expect(builders[1]?.prompt).toContain("say which check ran");
  });
});
