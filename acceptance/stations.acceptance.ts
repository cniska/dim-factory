import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefFrom } from "./support/brief";
import { refusal, resultOf } from "./support/dim-output";
import { type HarnessScript, type HarnessTurn, TMPDIR_PLACEHOLDER } from "./support/harness-script";
import { type Machine, type MachineOptions, machines, manifest, RECORD_PROBE } from "./support/machine";
import {
  addOrder,
  approve,
  built,
  planned,
  returnArtifact,
  reviewed,
  runOrder,
  shipThrough,
  showOrder,
  transcriptOf,
  updateOrder,
} from "./support/operator-acts";
import { actions, entryOf, sessionOf, workerOf } from "./support/order-view";
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
import {
  ACTION,
  type Action,
  NEXT,
  REFUSAL,
  STATION_NAMES,
  STATION_ROLES,
  STATIONS,
  type StationRole,
} from "./support/vocabulary";
import type { Slice } from "./support/worker-acts";

const start = machines();

const MIN_SENTENCE_LENGTH = 20;

const briefsOf = (m: Machine, role: StationRole) => m.invocations(role).map((call) => call.prompt);

const FAREWELL_SLICES: readonly Slice[] = [
  { title: "Write the farewell", outcome: "farewell.txt holds the farewell." },
  { title: "Link the farewell", outcome: "The README names farewell.txt." },
];

async function twoShippedOrders(): Promise<Machine> {
  const m = await start({
    script: {
      planner: [planTurn(), planTurn(FAREWELL_SLICES, "## Outcome\n\nA farewell under the greeting.")],
      builder: [
        buildTurn(),
        [
          { act: "write", path: "farewell.txt", content: "farewell\n" },
          { act: "commit", subject: "feat: write the farewell" },
          { act: "write", path: "README.md", content: "# widgets\n\nSee farewell.txt.\n" },
          { act: "commit", subject: "feat: link the farewell" },
          { act: "build-return", artifact: "## Outcome\n\nThe README ends with a farewell." },
        ],
      ],
      reviewer: [reviewTurn(), reviewTurn()],
    },
  });
  await shipThrough(m.operator, await addOrder(m.operator, { title: "Greet" }));
  await shipThrough(
    m.operator,
    await addOrder(m.operator, { title: "Farewell", description: "End the README with a farewell." }),
  );
  return m;
}

describe("skills", () => {
  test.todo("AC-18 the operator's instructions and intake are their own skills, and a shared instruction is a linked reference", () => {});
  test.todo("AC-19 no instruction is stated in two shipped skills, and none adds nothing in the record of orders using it", () => {});
  test.todo("AC-20 a project with no factory files runs an order to shipped, and the factory's own skills reach no user skill directory", () => {});
  test.todo("AC-27 every skill a brief names ships with the factory, and a machine with no personal skills runs an order to shipped", () => {});
});

describe("briefs", () => {
  test("AC-17 each station's brief is a fixed set of fields that names its skill", async () => {
    const m = await twoShippedOrders();

    for (const { role, skill } of Object.values(STATIONS)) {
      const first = briefFrom(m.invocation(role, 0).prompt);
      const second = briefFrom(m.invocation(role, 1).prompt);
      expect(first.skill).toBe(skill);
      expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    }
  });

  test("AC-23 no sentence of a brief repeats in the brief of an order with a different description", async () => {
    const m = await twoShippedOrders();

    const sentences = (brief: string) =>
      Object.entries(briefFrom(brief))
        .filter(([field]) => field !== "skill")
        .flatMap(([, value]) => JSON.stringify(value).split(/(?<=[.!?])\s+/))
        .filter((sentence) => sentence.length > MIN_SENTENCE_LENGTH);
    for (const role of STATION_ROLES) {
      const first = sentences(m.invocation(role, 0).prompt);
      const second = sentences(m.invocation(role, 1).prompt);
      expect(first.filter((sentence) => second.includes(sentence))).toEqual([]);
    }
  });

  test("AC-23 the planner is briefed with the description, the builder with the approved plan, the reviewer with the Build artifact and the diff", async () => {
    const m = await start({ script: happyPath() });
    await shipThrough(
      m.operator,
      await addOrder(m.operator, { description: "Add a greeting to the README, please." }),
    );

    expect(m.invocation("planner", 0).prompt).toContain("Add a greeting to the README, please.");
    for (const slice of SLICES) expect(m.invocation("builder", 0).prompt).toContain(slice.title);
    expect(m.invocation("reviewer", 0).prompt).toContain("The README links a greeting.");
    expect(m.invocation("reviewer", 0).prompt).toContain("slice-2.txt");
  });

  test("AC-23 the builder is briefed with the check the project declares, as the gates will run it", async () => {
    const m = await start({ script: happyPath() });
    await shipThrough(m.operator, await addOrder(m.operator));

    expect(briefFrom(m.invocation("builder", 0).prompt).check).toBe("bun run verify");
  });

  test("AC-17 each recorded slice of a plan has a title and an outcome", async () => {
    const m = await start({ script: happyPath() });
    const order = await showOrder(m.operator, await planned(m.operator));
    expect(order.slices.map(({ title, outcome }) => ({ title, outcome }))).toEqual([...SLICES]);
  });

  test("AC-26 an updated description briefs the next plan", async () => {
    const m = await start({
      script: { planner: [[{ act: "order-return", reason: "which README?" }], planTurn()] },
    });
    const id = await planned(m.operator);

    resultOf(await updateOrder(m.operator, id, "Add a greeting to the top-level README."));
    resultOf(await runOrder(m.operator, id));

    expect(m.invocation("planner", 1).prompt).toContain("Add a greeting to the top-level README.");
    expect((await showOrder(m.operator, id)).next).toBe(NEXT.approve);
  });
});

describe("a builder's commits", () => {
  test("AC-68 carry the owner's git identity and no signature, in a checkout that signs commits", async () => {
    const m = await start({ script: happyPath() });
    m.git(["config", "commit.gpgsign", "true"]);
    const id = await built(m.operator);

    const { branch } = await showOrder(m.operator, id);
    const commits = m.git(["log", "--format=%an <%ae>|%cn <%ce>|%G?", `main..${branch}`]).split("\n");
    expect(commits).toEqual([
      "Owner <owner@example.com>|Owner <owner@example.com>|N",
      "Owner <owner@example.com>|Owner <owner@example.com>|N",
    ]);
  });

  test("AC-69 run the project's own hooks, so a hook that refuses a commit leaves it uncommitted", async () => {
    const m = await start({ script: happyPath() });
    const hook = join(m.repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'refused by the project' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const id = await planned(m.operator);

    expect(refusal(await approve(m.operator, id)).code).toBeString();

    const order = await showOrder(m.operator, id);
    expect(m.commitsOn(order.branch)).toEqual([]);
    expect(actions(order)).not.toContain(ACTION.sliceSubmitted);
  });
});

describe("what a station worker may change", () => {
  test("AC-28 a planner's writes to the workspace and the record are refused and its plan comes only from its return", async () => {
    const m = await start({
      script: {
        planner: [
          [
            { act: "write", path: "planted-by-write.txt", content: "x\n" },
            { act: "sh", command: "echo x > planted-by-shell.txt" },
            { act: "sh", command: `touch "${RECORD_PROBE}"` },
            ...planTurn(),
          ],
        ],
      },
    });
    const order = await showOrder(m.operator, await planned(m.operator));

    expect(existsSync(join(order.workspace, "planted-by-write.txt"))).toBe(false);
    expect(existsSync(join(order.workspace, "planted-by-shell.txt"))).toBe(false);
    expect(existsSync(join(m.record, "planted"))).toBe(false);
    expect(actions(order).filter((action) => action === ACTION.planReturned)).toHaveLength(1);
  });

  test("AC-28 a planner that may not write the record still reads it, through its turn", async () => {
    const m = await start({
      script: { planner: [[{ act: "dim", args: ["query", "search", "greeting"] }, ...planTurn()]] },
    });
    const order = await showOrder(m.operator, await planned(m.operator));

    const results = (await transcriptOf(m.operator, sessionOf(workerOf(order, "planner"), 0).id)).flatMap(
      (entry) => (entry.type === "tool_result" ? [entry.output] : []),
    );
    expect(results[0]).toContain('"command":"query","ok":true');
  });

  test("AC-33 a reviewer's writes to the workspace and the record are refused", async () => {
    const m = await start({
      script: {
        ...happyPath(),
        reviewer: [
          [
            { act: "write", path: "planted.txt", content: "x\n" },
            { act: "sh", command: `echo x > planted-by-shell.txt; touch "${RECORD_PROBE}"` },
            ...reviewTurn(),
          ],
        ],
      },
    });
    const id = await built(m.operator);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(existsSync(join(order.workspace, "planted.txt"))).toBe(false);
    expect(existsSync(join(order.workspace, "planted-by-shell.txt"))).toBe(false);
    expect(existsSync(join(m.record, "planted"))).toBe(false);
  });
});

describe("slice gates", () => {
  const oneSlice = (acts: HarnessTurn): HarnessScript => ({
    planner: [planTurn([{ title: "One", outcome: "One file." }])],
    builder: [[...acts, { act: "build-return", artifact: BUILD_ARTIFACT }]],
  });

  test("AC-22 a slice with a comment, an unchanged test and an unusual subject is kept when the check passes", async () => {
    const m = await start({
      script: oneSlice([
        { act: "write", path: "greet.ts", content: "// says hello\nexport const greet = 'hello';\n" },
        { act: "commit", subject: "wip!! greeting, see thread" },
      ]),
    });
    const order = await showOrder(m.operator, await built(m.operator));

    expect(m.commitsOn(order.branch)).toEqual(["wip!! greeting, see thread"]);
    expect(order.next).toBe(NEXT.approve);
  });

  type RefusedCase = {
    readonly name: string;
    readonly options: MachineOptions;
    readonly acts: HarnessTurn;
    readonly during?: (m: Machine, id: string) => Promise<void>;
  };

  const refusedCases: readonly RefusedCase[] = [
    {
      name: "whose check fails",
      options: { check: "echo RED-CHECK-OUTPUT; [ ! -e red.txt ]" },
      acts: [{ act: "write", path: "red.txt", content: "x\n" }],
    },
    {
      name: "whose check rewrote files",
      options: { check: "[ ! -e rewrite-me.txt ] || echo rewritten >> rewrite-me.txt" },
      acts: [{ act: "write", path: "rewrite-me.txt", content: "x\n" }],
    },
    {
      name: "that changed the check's definition",
      options: { check: "[ ! -e red.txt ]" },
      acts: [
        { act: "write", path: "red.txt", content: "x\n" },
        { act: "write", path: "package.json", content: manifest({ verify: "true" }) },
      ],
    },
    {
      name: "whose commit is not on the recorded head of the order's branch",
      options: {},
      acts: [
        { act: "write", path: "one.txt", content: "x\n" },
        { act: "signal", name: "before-commit" },
        { act: "wait", name: "branch-moved" },
      ],
      async during(m, id) {
        await m.reached("before-commit");
        const { workspace } = await showOrder(m.operator, id);
        m.git(["commit", "-q", "--allow-empty", "-m", "chore: the owner moves the branch"], workspace);
        m.release("branch-moved");
      },
    },
  ];

  for (const { name, options, acts, during } of refusedCases) {
    test(`AC-22 a slice ${name} is refused and leaves the order's branch as it was`, async () => {
      const m = await start({
        ...options,
        script: oneSlice([...acts, { act: "commit", subject: "feat: add one" }]),
      });
      const id = await planned(m.operator);
      const building = approve(m.operator, id);
      await during?.(m, id);
      await building;

      const order = await showOrder(m.operator, id);
      expect(actions(order)).toContain(ACTION.sliceRefused);
      expect(actions(order)).not.toContain(ACTION.sliceAccepted);
      expect(m.commitsOn(order.branch)).not.toContain("feat: add one");
    });
  }

  test("AC-75 a slice whose check writes in the workspace, its temp directory and outside both is kept, with only the write outside refused", async () => {
    const m = await start({
      check: ({ root }) =>
        `mkdir -p node_modules && touch node_modules/inside && touch "$TMPDIR/tmp" && { touch "${root}/escaped" 2>/dev/null; true; }`,
      script: oneSlice([
        { act: "write", path: "one.txt", content: "x\n" },
        { act: "commit", subject: "feat: add one" },
      ]),
    });
    const order = await showOrder(m.operator, await built(m.operator));

    expect(m.commitsOn(order.branch)).toEqual(["feat: add one"]);
    expect(existsSync(join(order.workspace, "node_modules", "inside"))).toBe(true);
    expect(existsSync(join(m.root, "escaped"))).toBe(false);
  });

  test("AC-22 a builder's amended commit is refused as a moved head and the branch is put back at the recorded head", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            ...sliceActs(1),
            { act: "write", path: "slice-1.txt", content: "amended\n" },
            { act: "sh", command: "git add -A && git commit -q --amend -m 'feat: amend slice 1'" },
            { act: "dim", args: ["slice", "submit"] },
          ],
        ],
      },
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();

    const order = await showOrder(m.operator, id);
    const committed = entryOf(order, ACTION.sliceAccepted).details.commit;
    const refused = entryOf(order, ACTION.sliceRefused);
    if (refused.code !== REFUSAL.headMoved) throw new Error(`the slice was refused ${refused.code}`);
    expect(refused.details.head).toBe(committed);
    expect(m.git(["rev-parse", order.branch])).toBe(committed);
    expect(m.commitsOn(order.branch)).toEqual(["feat: add slice 1"]);
  });

  test("AC-31 a refused slice's log entry carries the check's output", async () => {
    const m = await start({
      check: "echo RED-CHECK-OUTPUT; [ ! -e red.txt ]",
      script: oneSlice([
        { act: "write", path: "red.txt", content: "x\n" },
        { act: "commit", subject: "feat: add red" },
      ]),
    });
    const id = await planned(m.operator);
    expect(refusal(await approve(m.operator, id)).code).toBeString();
    const order = await showOrder(m.operator, id);

    const refused = entryOf(order, ACTION.sliceRefused);
    if (refused.code !== "check_failed") throw new Error(`the slice was refused ${refused.code}`);
    expect(JSON.stringify(refused.evidence)).toContain("RED-CHECK-OUTPUT");
    expect(refused.details.command).toBe(refused.evidence[0].command);
    expect(refused.details.exitCode).toBe(1);
  });

  test("AC-62 a plan larger than one socket write hands over whole", async () => {
    const body = `## Outcome\n\n${Array.from({ length: 60_000 }, () => "A long plan line.").join("\n")}`;
    const m = await start({ script: { planner: [planTurn(undefined, body)] } });
    const order = await showOrder(m.operator, await planned(m.operator));

    expect(entryOf(order, ACTION.planReturned).details.body).toBe(body);
  });

  test("AC-62 a builder returns a Build artifact it wrote in its temp directory", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [
          [
            ...SLICES.flatMap((_, i) => sliceActs(i + 1)),
            { act: "write", path: `${TMPDIR_PLACEHOLDER}/build.md`, content: BUILD_ARTIFACT },
            { act: "sh", command: 'dim build return "$TMPDIR/build.md"' },
          ],
        ],
      },
    });
    const order = await showOrder(m.operator, await built(m.operator));

    expect(entryOf(order, ACTION.buildReturned).details.artifact).toBe(BUILD_ARTIFACT);
  });

  test("AC-62 a reviewer, which may not edit the workspace, returns a Review artifact it wrote in its temp directory", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [buildTurn()],
        reviewer: [
          [
            {
              act: "write",
              path: `${TMPDIR_PLACEHOLDER}/review.json`,
              content: JSON.stringify(REVIEW_ARTIFACT),
            },
            { act: "sh", command: 'dim review return --artifact "$TMPDIR/review.json"' },
          ],
        ],
      },
    });
    const order = await showOrder(m.operator, await reviewed(m.operator));

    expect(entryOf(order, ACTION.reviewReturned).details).toEqual({
      returned: { kind: "artifact", artifact: REVIEW_ARTIFACT },
    });
  });

  test("AC-30 one build commits each slice in order through the gates and returns once", async () => {
    const m = await start({ script: happyPath() });
    const order = await showOrder(m.operator, await built(m.operator));

    expect(briefsOf(m, "builder")).toHaveLength(1);
    expect(m.commitsOn(order.branch)).toEqual(["feat: add slice 1", "feat: add slice 2"]);
    const buildActions: readonly Action[] = [ACTION.sliceAccepted, ACTION.buildReturned];
    const build = actions(order).filter((action) => buildActions.includes(action));
    expect(build).toEqual([ACTION.sliceAccepted, ACTION.sliceAccepted, ACTION.buildReturned]);
  });
});

describe("definitions of done", () => {
  test("AC-29 a plan with no slice records nothing and goes back to the planner, whose corrected plan is accepted", async () => {
    const m = await start({ script: { planner: [[...planTurn([]), ...planTurn()]] } });
    const order = await showOrder(m.operator, await planned(m.operator));

    expect(briefsOf(m, "planner")).toHaveLength(1);
    expect(actions(order).filter((action) => action === ACTION.planReturned)).toHaveLength(1);
    expect(order.slices).toHaveLength(2);
    expect(order.next).toBe(NEXT.approve);
  });

  test("AC-29 a second return that misses the definition of done fails the station, and a later return is not taken", async () => {
    const m = await start({ script: { planner: [[...planTurn([]), ...planTurn([]), ...planTurn()]] } });
    const id = await addOrder(m.operator);

    const ran = await runOrder(m.operator, id);

    expect(refusal(ran).code).toBeString();
    const order = await showOrder(m.operator, id);
    expect(actions(order)).not.toContain(ACTION.planReturned);
    expect(actions(order)).toContain(ACTION.stationFailed);
    expect(order.slices).toHaveLength(0);
  });

  test("AC-29 a slice commit with no subject line is refused by git, records nothing, and the builder's corrected commit is kept", async () => {
    const m = await start({
      script: {
        planner: [planTurn([{ title: "One", outcome: "One file." }])],
        builder: [
          [
            { act: "write", path: "one.txt", content: "x\n" },
            { act: "commit", subject: "" },
            { act: "commit", subject: "feat: add one" },
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
      },
    });
    const order = await showOrder(m.operator, await built(m.operator));

    expect(m.commitsOn(order.branch)).toEqual(["feat: add one"]);
    expect(actions(order).filter((action) => action === ACTION.sliceSubmitted)).toHaveLength(1);
    expect(actions(order)).not.toContain(ACTION.sliceRefused);
    expect(order.next).toBe(NEXT.approve);
  });

  test("AC-29 a review finding with no file records nothing and the reviewer's corrected findings are accepted", async () => {
    const m = await start({
      script: {
        ...happyPath(),
        reviewer: [[...findingsTurn([{ ...finding(), file: "" }]), ...findingsTurn([finding()])]],
      },
    });
    const id = await built(m.operator);
    await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(order.findings.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "slice-1.txt", line: 1 },
    ]);
    expect(order.station).toBe("build");
  });

  test("AC-62 a build with an uncommitted slice does not hand over", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [[...sliceActs(1), { act: "build-return", artifact: BUILD_ARTIFACT }]],
      },
    });
    const id = await planned(m.operator);

    const ran = await approve(m.operator, id);

    const order = await showOrder(m.operator, id);
    expect(refusal(ran).code).toBeString();
    expect(actions(order)).not.toContain(ACTION.buildReturned);
    expect(order.next).toBe(NEXT.run);
  });

  test("AC-62 every artifact a station hands over waits for approval", async () => {
    const m = await start({ script: happyPath() });
    const id = await addOrder(m.operator);
    for (const station of STATION_NAMES) {
      const ran = station === "plan" ? await runOrder(m.operator, id) : await approve(m.operator, id);
      resultOf(ran);
      const order = await showOrder(m.operator, id);
      expect([order.station, order.next]).toEqual([station, NEXT.approve]);
    }
  });

  test("AC-32 a Review artifact that does not say which areas it covered is refused", async () => {
    const m = await start({
      script: {
        ...happyPath(),
        reviewer: [
          [
            { act: "review-return", artifact: { ...REVIEW_ARTIFACT, covered: [] } },
            { act: "review-return", artifact: { ...REVIEW_ARTIFACT, covered: [] } },
          ],
        ],
      },
    });
    const id = await built(m.operator);

    const ran = await approve(m.operator, id);

    expect(refusal(ran).code).toBeString();
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
    const id = await built(m.operator);
    await approve(m.operator, id);
    return id;
  }

  test("AC-33 findings put the order at build in the same run, where the builder's fix passes the slice gates and answers each finding once", async () => {
    const m = await start({
      script: reviewedWithFinding([
        { act: "write", path: "slice-1.txt", content: "hello\n" },
        { act: "commit", subject: "fix: say hello" },
        { act: "answer", file: "slice-1.txt", line: 1, answer: "fixed", reason: "it says hello now" },
        { act: "build-return", artifact: BUILD_ARTIFACT },
      ]),
    });
    const id = await atFindings(m);

    const order = await showOrder(m.operator, id);
    expect(order.station).toBe("build");
    expect(order.findings[0]?.answer).toBe("fixed");
    expect(m.commitsOn(order.branch).at(-1)).toBe("fix: say hello");
    expect(order.next).toBe(NEXT.approve);
    resultOf(await approve(m.operator, id));
    expect(m.invocation("reviewer", 1).prompt).toContain("it says hello now");
  });

  test("AC-33 AC-62 a build turn that leaves a finding unanswered is refused", async () => {
    const m = await start({
      script: reviewedWithFinding([{ act: "build-return", artifact: BUILD_ARTIFACT }]),
    });
    const id = await atFindings(m);

    const order = await showOrder(m.operator, id);
    expect(order.findings).toHaveLength(1);
    expect(order.findings[0]).not.toHaveProperty("answer");
    expect(actions(order).filter((action) => action === ACTION.buildReturned)).toHaveLength(1);
  });

  test("AC-33 a finding answered twice is refused the second time", async () => {
    const answer = { act: "answer", file: "slice-1.txt", line: 1, reason: "it holds" } as const;
    const m = await start({
      script: reviewedWithFinding([
        { ...answer, answer: "refused" },
        { ...answer, answer: "fixed" },
        { act: "build-return", artifact: BUILD_ARTIFACT },
      ]),
    });
    const id = await atFindings(m);

    const order = await showOrder(m.operator, id);
    expect(order.findings[0]?.answer).toBe("refused");
    expect(actions(order).filter((action) => action === ACTION.findingAnswered)).toHaveLength(1);
  });
});

describe("going back to plan", () => {
  test("AC-25 slices committed before a builder's return to plan stay, and the revised plan decides which stay", async () => {
    const m = await start({
      script: {
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
            { act: "order-return", reason: "the third slice needs the second gone" },
          ],
          [
            { act: "sh", command: "rm slice-2.txt" },
            { act: "commit", subject: "refactor: drop slice 2" },
            ...sliceActs(3),
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
        reviewer: [reviewTurn()],
      },
    });
    const id = await built(m.operator);
    const returned = await showOrder(m.operator, id);
    expect(returned.station).toBe("plan");
    expect(m.commitsOn(returned.branch)).toEqual(["feat: add slice 1", "feat: add slice 2"]);

    await runOrder(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);
    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    expect(m.onMain("slice-1.txt")).toBe(true);
    expect(m.onMain("slice-3.txt")).toBe(true);
    expect(m.onMain("slice-2.txt")).toBe(false);
  });
});

describe("the operator's decisions", () => {
  test("AC-5 a returned Build artifact runs the same builder again, briefed with the reason", async () => {
    const m = await start({
      script: {
        planner: [planTurn()],
        builder: [buildTurn(), [{ act: "build-return", artifact: `${BUILD_ARTIFACT}\n\nRevised.` }]],
      },
    });
    const id = await built(m.operator);

    resultOf(await returnArtifact(m.operator, id, "say which check ran"));

    expect(m.invocation("builder", 1).resumed).toBe(m.invocation("builder", 0).sessionId);
    expect(m.invocation("builder", 1).prompt).toContain("say which check ran");
    const returned = entryOf(await showOrder(m.operator, id), ACTION.artifactReturned).details;
    expect({ station: returned.station, reason: returned.reason, decidedBy: returned.decidedBy }).toEqual({
      station: "build",
      reason: "say which check ran",
      decidedBy: "owner",
    });
  });
});
