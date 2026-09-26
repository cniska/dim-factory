import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { claimOrder, moveOrder, queueOrder, setOrderHold } from "./factory-order-lifecycle";
import { closeOrderReview } from "./factory-order-review";
import { integratedRepo, located, reviewIn, workerIn } from "./fixtures.test-support";
import {
  answerOrderFindings,
  raiseOrderFinding,
  recordOwnerRuling,
  ruleOnOrderFinding,
} from "./order-finding";
import {
  displayedAnswer,
  type FindingStanding,
  findingStanding,
  orderFindingStandings,
} from "./order-finding-state";
import { dbPath } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

type Floor = { db: Database; builder: string; operator: string };

function floor(db = new Database(":memory:"), schema = true): Floor {
  if (schema) db.run(SCHEMA_SQL);
  const builder = workerIn(db);
  const operator = workerIn(db, "operator");
  queueOrder(db, { id: "order-1", project: "cniska/dim-factory", title: "Rule on findings" }, operator);
  claimOrder(
    db,
    "order-1",
    { runId: "run-1", sessionId: "session-1", station: "review", operatorWorker: operator },
    operator,
    undefined,
    trunk.dir,
  );
  return { db, builder, operator };
}

function answer(f: Floor, finding: number, given: "fixed" | "refused", run = "build-1"): void {
  answerOrderFindings(
    f.db,
    "order-1",
    run,
    [{ finding, answer: given, resolution: given === "refused" ? "the gate is a later slice" : null }],
    f.builder,
  );
}

function answered(f: Floor, given: "fixed" | "refused"): { finding: number; reviewer: string } {
  const first = reviewIn(f.db, "order-1", f.operator);
  const finding = raiseOrderFinding(
    f.db,
    "order-1",
    located({ dimension: "tests", failure: "no test holds the gate" }),
    first.reviewer,
  );
  closeOrderReview(f.db, first.review, "closed", first.reviewer);
  answer(f, finding, given);
  const second = reviewIn(f.db, "order-1", f.operator);
  return { finding, reviewer: second.reviewer };
}

function openRound(f: Floor): number {
  return f.db.query<{ id: number }, []>("SELECT id FROM factory_order_review WHERE closed_at IS NULL").get()
    ?.id as number;
}

function nextRound(f: Floor, reviewer: string): string {
  closeOrderReview(f.db, openRound(f), "closed", reviewer);
  return reviewIn(f.db, "order-1", f.operator).reviewer;
}

describe("the answer a finding shows", () => {
  test("is unanswered while the finding owes one and the latest answer otherwise", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    expect(displayedAnswer(findingStanding(f.db, finding) as FindingStanding)).toBe("fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    expect(displayedAnswer(findingStanding(f.db, finding) as FindingStanding)).toBe("unanswered");
  });

  test("refuses a settled finding with no answer recorded", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    const standing = findingStanding(f.db, finding) as FindingStanding;
    expect(() => displayedAnswer({ ...standing, state: "settled", answer: null })).toThrow(
      `finding ${finding} is settled with no answer recorded`,
    );
  });
});

describe("finding state", () => {
  test("a finding with no answer is open and owes one", () => {
    const f = floor();
    const round = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      located({ dimension: "docs", failure: "stale" }),
      round.reviewer,
    );
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answer: null, answered: false });
  });

  test("an answer no round has ruled on leaves the finding open and answered", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answer: "fixed", answered: true });
  });

  test("not_addressed leaves a fixed finding open and owing a new answer", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answered: false });
  });

  test("addressed settles a fixed finding", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer);
    expect(findingStanding(f.db, finding)?.state).toBe("settled");
  });

  test("an accepted refusal is settled", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_accepted" }, reviewer);
    expect(findingStanding(f.db, finding)?.state).toBe("settled");
  });

  test("a contested refusal awaits the owner until upheld", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(
      f.db,
      finding,
      { ruling: "refusal_contested", reason: "the gate is this slice" },
      reviewer,
    );
    expect(findingStanding(f.db, finding)?.state).toBe("awaiting_owner");
    recordOwnerRuling(f.db, finding, { ruling: "refusal_upheld", reason: "later slice" }, f.operator);
    expect(findingStanding(f.db, finding)).toMatchObject({
      state: "settled",
      ruling: "refusal_contested",
      ownerRuling: "refusal_upheld",
    });
  });

  test("an overturned refusal owes a new answer, which a later round then rules on", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(
      f.db,
      finding,
      { ruling: "refusal_contested", reason: "the gate is this slice" },
      reviewer,
    );
    recordOwnerRuling(f.db, finding, { ruling: "refusal_overturned", reason: "fix it here" }, f.operator);
    expect(findingStanding(f.db, finding)).toMatchObject({
      state: "open",
      answered: false,
      refusalStands: false,
    });
    const third = nextRound(f, reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, third)).toThrow(
      expect.objectContaining({ code: "ruling_not_applicable" }),
    );
    closeOrderReview(f.db, openRound(f), "closed", third);
    answer(f, finding, "fixed", "build-2");
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answer: "fixed", answered: true });
    const fourth = reviewIn(f.db, "order-1", f.operator).reviewer;
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "refusal_accepted" }, fourth)).toThrow(
      expect.objectContaining({ code: "ruling_not_applicable" }),
    );
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, fourth);
    expect(orderFindingStandings(f.db, "order-1").map((s) => s.state)).toEqual(["settled"]);
  });

  test("a finding found not addressed is work again until a later attempt's answer settles it", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answer: "fixed", answered: false });
    answer(f, finding, "fixed", "build-2");
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", answer: "fixed", answered: true });
    const third = reviewIn(f.db, "order-1", f.operator).reviewer;
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, third);
    expect(findingStanding(f.db, finding)?.state).toBe("settled");
    expect(
      f.db
        .query("SELECT run_id, answer FROM factory_order_finding_answer WHERE finding_id = ? ORDER BY id")
        .all(finding),
    ).toEqual([
      { run_id: "build-1", answer: "fixed" },
      { run_id: "build-2", answer: "fixed" },
    ]);
  });

  test("a later attempt may refuse a finding found not addressed, and the next round judges the refusal", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    answer(f, finding, "refused", "build-2");
    expect(findingStanding(f.db, finding)).toMatchObject({ answered: true, refusalStands: true });
    const third = reviewIn(f.db, "order-1", f.operator).reviewer;
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_accepted" }, third);
    expect(findingStanding(f.db, finding)?.state).toBe("settled");
  });
});

describe("recording an answer", () => {
  function raised(f: Floor): number {
    const round = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      located({ dimension: "docs", failure: "stale" }),
      round.reviewer,
    );
    closeOrderReview(f.db, round.review, "closed", round.reviewer);
    return finding;
  }

  test("writes the answer under the run and a finding_answered event under the builder", () => {
    const f = floor();
    const finding = raised(f);
    answerOrderFindings(
      f.db,
      "order-1",
      "build-7",
      [{ finding, answer: "refused", resolution: "no doc names it" }],
      f.builder,
      "2026-09-26T10:00:00.000Z",
    );
    expect(
      f.db.query("SELECT finding_id, run_id, answer, resolution FROM factory_order_finding_answer").all(),
    ).toEqual([{ finding_id: finding, run_id: "build-7", answer: "refused", resolution: "no doc names it" }]);
    expect(
      f.db.query("SELECT worker, finding_id FROM factory_order_event WHERE kind = 'finding_answered'").all(),
    ).toEqual([{ worker: f.builder, finding_id: finding }]);
  });

  test("is refused from any hand but a builder", () => {
    const f = floor();
    const finding = raised(f);
    expect(() =>
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "fixed", resolution: null }],
        f.operator,
      ),
    ).toThrow(expect.objectContaining({ code: "worker_not_builder" }));
  });

  test("is refused while the finding's last answer waits on a ruling", () => {
    const f = floor();
    const finding = raised(f);
    answer(f, finding, "fixed");
    expect(() => answer(f, finding, "fixed", "build-2")).toThrow(
      expect.objectContaining({ code: "answer_not_owed" }),
    );
  });

  test("is refused on a settled finding", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer);
    expect(() => answer(f, finding, "fixed", "build-2")).toThrow(
      expect.objectContaining({ code: "answer_not_owed" }),
    );
  });

  test("is refused on a finding of another order or none", () => {
    const f = floor();
    expect(() => answer(f, 999, "fixed")).toThrow(expect.objectContaining({ code: "finding_unknown" }));
  });

  test("takes only fixed on a refusal the owner overturned", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    recordOwnerRuling(f.db, finding, { ruling: "refusal_overturned", reason: "fix it" }, f.operator);
    expect(() => answer(f, finding, "refused", "build-2")).toThrow(
      expect.objectContaining({ code: "refusal_overturned" }),
    );
    answer(f, finding, "fixed", "build-2");
    expect(findingStanding(f.db, finding)).toMatchObject({ answer: "fixed", answered: true });
  });

  test("leaves a refusal without a resolution to the table's check", () => {
    const f = floor();
    const finding = raised(f);
    expect(() =>
      answerOrderFindings(
        f.db,
        "order-1",
        "build-1",
        [{ finding, answer: "refused", resolution: " " }],
        f.builder,
      ),
    ).toThrow("CHECK constraint failed");
  });
});

describe("recording a ruling", () => {
  test("is refused from any hand but the open round's reviewer", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, f.builder)).toThrow(
      expect.objectContaining({ code: "review_not_its_reviewer" }),
    );
  });

  test("is refused on a finding the same round raised", () => {
    const f = floor();
    const round = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      located({ dimension: "docs", failure: "stale" }),
      round.reviewer,
    );
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, round.reviewer)).toThrow(
      expect.objectContaining({ code: "finding_same_round" }),
    );
  });

  test("is refused on a finding a later round finds settled or awaiting the owner", () => {
    const settled = floor();
    const fixed = answered(settled, "fixed");
    ruleOnOrderFinding(settled.db, fixed.finding, { ruling: "addressed" }, fixed.reviewer);
    const afterFix = nextRound(settled, fixed.reviewer);
    expect(() =>
      ruleOnOrderFinding(settled.db, fixed.finding, { ruling: "not_addressed", reason: "no" }, afterFix),
    ).toThrow(expect.objectContaining({ code: "finding_not_open" }));
    const awaiting = floor();
    const refused = answered(awaiting, "refused");
    ruleOnOrderFinding(
      awaiting.db,
      refused.finding,
      { ruling: "refusal_contested", reason: "in scope" },
      refused.reviewer,
    );
    const afterContest = nextRound(awaiting, refused.reviewer);
    expect(() =>
      ruleOnOrderFinding(awaiting.db, refused.finding, { ruling: "refusal_accepted" }, afterContest),
    ).toThrow(expect.objectContaining({ code: "finding_not_open" }));
  });

  test("is refused on a finding that does not exist or with no round open", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    expect(() => ruleOnOrderFinding(f.db, 999, { ruling: "addressed" }, reviewer)).toThrow(
      expect.objectContaining({ code: "finding_unknown" }),
    );
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer)).toThrow(
      expect.objectContaining({ code: "review_unknown" }),
    );
  });

  test("is refused a second time in the same round", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer)).toThrow(
      expect.objectContaining({ code: "ruling_repeated" }),
    );
  });

  test("is refused on a finding the builder has not answered since its last ruling", () => {
    const f = floor();
    const first = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      located({ dimension: "docs", failure: "stale" }),
      first.reviewer,
    );
    const second = nextRound(f, first.reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, second)).toThrow(
      expect.objectContaining({ code: "ruling_not_applicable" }),
    );
    const again = floor();
    const fixed = answered(again, "fixed");
    ruleOnOrderFinding(
      again.db,
      fixed.finding,
      { ruling: "not_addressed", reason: "no test" },
      fixed.reviewer,
    );
    const third = nextRound(again, fixed.reviewer);
    expect(() => ruleOnOrderFinding(again.db, fixed.finding, { ruling: "addressed" }, third)).toThrow(
      expect.objectContaining({ code: "ruling_not_applicable" }),
    );
  });

  test("holds the refusal rulings to standing refusals and the others to fixed findings", () => {
    const refused = floor();
    const onRefusal = answered(refused, "refused");
    expect(() =>
      ruleOnOrderFinding(refused.db, onRefusal.finding, { ruling: "addressed" }, onRefusal.reviewer),
    ).toThrow(expect.objectContaining({ code: "ruling_not_applicable" }));
    const fixed = floor();
    const onFix = answered(fixed, "fixed");
    expect(() =>
      ruleOnOrderFinding(fixed.db, onFix.finding, { ruling: "refusal_accepted" }, onFix.reviewer),
    ).toThrow(expect.objectContaining({ code: "ruling_not_applicable" }));
  });

  test("requires a reason for not_addressed and refusal_contested", () => {
    const fixed = floor();
    const onFix = answered(fixed, "fixed");
    expect(() =>
      ruleOnOrderFinding(fixed.db, onFix.finding, { ruling: "not_addressed", reason: " " }, onFix.reviewer),
    ).toThrow(expect.objectContaining({ code: "reason_missing" }));
    const refused = floor();
    const onRefusal = answered(refused, "refused");
    expect(() =>
      ruleOnOrderFinding(refused.db, onRefusal.finding, { ruling: "refusal_contested" }, onRefusal.reviewer),
    ).toThrow(expect.objectContaining({ code: "reason_missing" }));
  });

  test("writes a finding_ruled event naming the finding and the round", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    const event = ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer);
    expect(
      f.db
        .query("SELECT kind, worker, finding_id, review_id, evidence FROM factory_order_event WHERE id = ?")
        .get(event),
    ).toEqual({
      kind: "finding_ruled",
      worker: reviewer,
      finding_id: finding,
      review_id: openRound(f),
      evidence: '{"ruling":"addressed"}',
    });
  });
});

describe("closing a round", () => {
  const hold = (f: Floor) =>
    f.db.query<{ hold: string | null }, []>("SELECT hold FROM factory_order WHERE id = 'order-1'").get()
      ?.hold;

  test("holds for approval when the round ruled every earlier finding addressed", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    expect(hold(f)).toBe("approval");
  });

  test("returns to the builder without a hold when the round ruled a fix not_addressed", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    expect(hold(f)).toBeNull();
  });

  test("holds a contested refusal for the owner and releases the hold when the owner overturns it", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    expect(hold(f)).toBe("approval");
    recordOwnerRuling(f.db, finding, { ruling: "refusal_overturned", reason: "fix it" }, f.operator);
    expect(hold(f)).toBeNull();
  });

  test("returns to the builder without a hold while an earlier finding is unanswered", () => {
    const f = floor();
    const first = reviewIn(f.db, "order-1", f.operator);
    raiseOrderFinding(f.db, "order-1", located({ dimension: "docs", failure: "stale" }), first.reviewer);
    const second = nextRound(f, first.reviewer);
    closeOrderReview(f.db, openRound(f), "closed", second);
    expect(hold(f)).toBeNull();
  });

  function contestedAndClosed(): Floor & { finding: number } {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    closeOrderReview(f.db, openRound(f), "closed", reviewer);
    return { ...f, finding };
  }

  test("keeps the hold when the owner upholds the refusal", () => {
    const f = contestedAndClosed();
    recordOwnerRuling(f.db, f.finding, { ruling: "refusal_upheld", reason: "later" }, f.operator);
    expect(hold(f)).toBe("approval");
  });

  test("keeps a hold that is not the review's approval hold through an overturn", () => {
    const owner = contestedAndClosed();
    setOrderHold(owner.db, "order-1", "the owner wants to read it first", owner.operator);
    recordOwnerRuling(
      owner.db,
      owner.finding,
      { ruling: "refusal_overturned", reason: "fix" },
      owner.operator,
    );
    expect(hold(owner)).toBe("the owner wants to read it first");
    const elsewhere = contestedAndClosed();
    moveOrder(elsewhere.db, "order-1", "build", elsewhere.operator);
    recordOwnerRuling(
      elsewhere.db,
      elsewhere.finding,
      { ruling: "refusal_overturned", reason: "fix" },
      elsewhere.operator,
    );
    expect(hold(elsewhere)).toBe("approval");
  });
});

describe("recording an owner ruling", () => {
  function contested(): Floor & { finding: number } {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    return { ...f, finding };
  }

  test("is refused from anyone but the operator", () => {
    const f = contested();
    expect(() =>
      recordOwnerRuling(f.db, f.finding, { ruling: "refusal_upheld", reason: "fine" }, f.builder),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
  });

  test("is refused unless the finding awaits the owner", () => {
    const f = floor();
    const { finding } = answered(f, "refused");
    expect(() =>
      recordOwnerRuling(f.db, finding, { ruling: "refusal_upheld", reason: "fine" }, f.operator),
    ).toThrow(expect.objectContaining({ code: "finding_not_awaiting_owner" }));
  });

  test("requires a reason", () => {
    const f = contested();
    expect(() =>
      recordOwnerRuling(f.db, f.finding, { ruling: "refusal_upheld", reason: "" }, f.operator),
    ).toThrow(expect.objectContaining({ code: "reason_missing" }));
  });

  test("sits in the ruling table beside the reviewer's, naming no round", () => {
    const f = contested();
    recordOwnerRuling(f.db, f.finding, { ruling: "refusal_overturned", reason: "fix it" }, f.operator);
    expect(
      f.db
        .query(
          "SELECT review_id IS NULL AS owner, ruling, reason, worker FROM factory_order_finding_ruling WHERE finding_id = ? ORDER BY id",
        )
        .all(f.finding),
    ).toEqual([
      { owner: 0, ruling: "refusal_contested", reason: "in scope", worker: expect.any(String) },
      { owner: 1, ruling: "refusal_overturned", reason: "fix it", worker: f.operator },
    ]);
  });

  test("writes a refusal_decided event", () => {
    const f = contested();
    const event = recordOwnerRuling(
      f.db,
      f.finding,
      { ruling: "refusal_overturned", reason: "fix it" },
      f.operator,
    );
    expect(
      f.db
        .query("SELECT kind, worker, finding_id, evidence FROM factory_order_event WHERE id = ?")
        .get(event),
    ).toEqual({
      kind: "refusal_decided",
      worker: f.operator,
      finding_id: f.finding,
      evidence: '{"ruling":"refusal_overturned"}',
    });
  });
});

describe("the finding tables", () => {
  const insertRuling = (
    f: Floor,
    finding: number,
    review: number | null,
    ruling: string,
    reason: string | null,
  ) =>
    f.db.run(
      `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, reason, worker, ruled_at)
       VALUES (?, ?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
      [finding, review, ruling, reason, f.operator],
    );

  test("hold a severity to critical, high or medium", () => {
    const f = floor();
    const round = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      located({ dimension: "docs", failure: "stale" }),
      round.reviewer,
    );
    f.db.run("UPDATE factory_order_finding SET severity = 'high' WHERE id = ?", [finding]);
    expect(() =>
      f.db.run("UPDATE factory_order_finding SET severity = 'low' WHERE id = ?", [finding]),
    ).toThrow("CHECK constraint failed");
  });

  test("hold one answer per finding per run, with a resolution on a refusal", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    const insert = (run: string, given: string, resolution: string | null) =>
      f.db.run(
        `INSERT INTO factory_order_finding_answer (finding_id, run_id, answer, resolution, recorded_at)
         VALUES (?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
        [finding, run, given, resolution],
      );
    expect(() => insert("build-1", "fixed", null)).toThrow("UNIQUE constraint failed");
    expect(() => insert("build-2", "refused", " ")).toThrow("CHECK constraint failed");
    expect(() => insert("build-2", "waived", null)).toThrow("CHECK constraint failed");
    insert("build-2", "refused", "out of scope");
  });

  test("refuse a ruling without a reason unless it is addressed or refusal_accepted", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    for (const ruling of ["not_addressed", "refusal_contested"]) {
      expect(() => insertRuling(f, finding, openRound(f), ruling, " ")).toThrow("CHECK constraint failed");
    }
    for (const ruling of ["refusal_upheld", "refusal_overturned"]) {
      expect(() => insertRuling(f, finding, null, ruling, null)).toThrow("CHECK constraint failed");
    }
  });

  test("hold one ruling per round and one owner ruling per finding", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    insertRuling(f, finding, openRound(f), "not_addressed", "still no test");
    expect(() => insertRuling(f, finding, openRound(f), "addressed", null)).toThrow(
      "UNIQUE constraint failed",
    );
    insertRuling(f, finding, null, "refusal_upheld", "fine");
    expect(() => insertRuling(f, finding, null, "refusal_overturned", "changed my mind")).toThrow(
      "UNIQUE constraint failed",
    );
  });

  test("give a round to a reviewer's ruling and none to the owner's", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    expect(() => insertRuling(f, finding, null, "addressed", null)).toThrow("CHECK constraint failed");
    expect(() => insertRuling(f, finding, openRound(f), "refusal_upheld", "fine")).toThrow(
      "CHECK constraint failed",
    );
    expect(() => insertRuling(f, finding, openRound(f), "partly_addressed", "half")).toThrow(
      "CHECK constraint failed",
    );
  });

  test("keep answers, rulings and owner rulings through rebuild", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-ruling-"));
    const environment = { HOME: home, DIM_HOME: home };
    const f = floor(openDb(dbPath(environment)), false);
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    recordOwnerRuling(f.db, finding, { ruling: "refusal_upheld", reason: "later" }, f.operator);
    closeDb(f.db);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(findingStanding(rebuilt, finding)).toMatchObject({
      answer: "refused",
      ruling: "refusal_contested",
      ownerRuling: "refusal_upheld",
      state: "settled",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });
});
