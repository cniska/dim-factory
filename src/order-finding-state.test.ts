import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import {
  answerOrderFinding,
  claimOrder,
  closeOrderReview,
  decideOrderRefusal,
  queueOrder,
  raiseOrderFinding,
  ruleOnOrderFinding,
} from "./factory-order";
import { integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { findingStanding, orderFindingStandings } from "./order-finding-state";
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
    { runId: "run-1", sessionId: "session-1", station: "dim-station-review", operatorWorker: operator },
    operator,
    undefined,
    trunk.dir,
  );
  return { db, builder, operator };
}

/** Round one raises a finding the builder answers, and round two is open to rule on it. */
function answered(f: Floor, answer: "fixed" | "refused"): { finding: number; reviewer: string } {
  const first = reviewIn(f.db, "order-1", f.operator);
  const finding = raiseOrderFinding(
    f.db,
    "order-1",
    { dimension: "tests", summary: "no test holds the gate" },
    first.reviewer,
  );
  closeOrderReview(f.db, first.review, "closed", first.reviewer);
  answerOrderFinding(
    f.db,
    finding,
    answer === "fixed" ? { answer } : { answer, resolution: "the gate is a later slice" },
    f.builder,
  );
  const second = reviewIn(f.db, "order-1", f.operator);
  return { finding, reviewer: second.reviewer };
}

function openRound(f: Floor): number {
  return f.db.query<{ id: number }, []>("SELECT id FROM factory_order_review WHERE closed_at IS NULL").get()
    ?.id as number;
}

/** Closes the open round and opens the next, returning its reviewer. */
function nextRound(f: Floor, reviewer: string): string {
  closeOrderReview(f.db, openRound(f), "closed", reviewer);
  return reviewIn(f.db, "order-1", f.operator).reviewer;
}

describe("finding state", () => {
  test("a finding with no ruling is open", () => {
    const f = floor();
    const { finding } = answered(f, "fixed");
    expect(findingStanding(f.db, finding)?.state).toBe("open");
  });

  test("not_addressed leaves a fixed finding open", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    ruleOnOrderFinding(f.db, finding, { ruling: "not_addressed", reason: "still no test" }, reviewer);
    expect(findingStanding(f.db, finding)?.state).toBe("open");
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
    decideOrderRefusal(f.db, finding, { decision: "refusal_upheld", reason: "later slice" }, f.operator);
    expect(findingStanding(f.db, finding)?.state).toBe("settled");
  });

  test("an overturned refusal is open work until a later round finds it addressed", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(
      f.db,
      finding,
      { ruling: "refusal_contested", reason: "the gate is this slice" },
      reviewer,
    );
    decideOrderRefusal(f.db, finding, { decision: "refusal_overturned", reason: "fix it here" }, f.operator);
    expect(findingStanding(f.db, finding)).toMatchObject({ state: "open", refusalStands: false });
    const third = nextRound(f, reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "refusal_accepted" }, third)).toThrow(
      expect.objectContaining({ code: "ruling_not_applicable" }),
    );
    ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, third);
    expect(orderFindingStandings(f.db, "order-1").map((s) => s.state)).toEqual(["settled"]);
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
      { dimension: "docs", summary: "stale" },
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

  test("is refused on a finding the builder has not answered", () => {
    const f = floor();
    const first = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      { dimension: "docs", summary: "stale" },
      first.reviewer,
    );
    const second = nextRound(f, first.reviewer);
    expect(() => ruleOnOrderFinding(f.db, finding, { ruling: "addressed" }, second)).toThrow(
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

describe("recording an owner decision", () => {
  function contested(): Floor & { finding: number } {
    const f = floor();
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    return { ...f, finding };
  }

  test("is refused from anyone but the operator", () => {
    const f = contested();
    expect(() =>
      decideOrderRefusal(f.db, f.finding, { decision: "refusal_upheld", reason: "fine" }, f.builder),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
  });

  test("is refused unless the finding awaits the owner", () => {
    const f = floor();
    const { finding } = answered(f, "refused");
    expect(() =>
      decideOrderRefusal(f.db, finding, { decision: "refusal_upheld", reason: "fine" }, f.operator),
    ).toThrow(expect.objectContaining({ code: "finding_not_awaiting_owner" }));
  });

  test("requires a reason", () => {
    const f = contested();
    expect(() =>
      decideOrderRefusal(f.db, f.finding, { decision: "refusal_upheld", reason: "" }, f.operator),
    ).toThrow(expect.objectContaining({ code: "reason_missing" }));
  });

  test("writes a refusal_decided event", () => {
    const f = contested();
    const event = decideOrderRefusal(
      f.db,
      f.finding,
      { decision: "refusal_overturned", reason: "fix it" },
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
      evidence: '{"decision":"refusal_overturned"}',
    });
  });

  test("the table holds one decision per finding, from the two decisions, with a reason", () => {
    const f = contested();
    const insert = (decision: string, reason: string) =>
      f.db.run(
        `INSERT INTO factory_order_refusal_decision (finding_id, decision, reason, worker, decided_at)
         VALUES (?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
        [f.finding, decision, reason, f.operator],
      );
    expect(() => insert("refusal_waived", "fine")).toThrow("CHECK constraint failed");
    expect(() => insert("refusal_upheld", " ")).toThrow("CHECK constraint failed");
    insert("refusal_upheld", "fine");
    expect(() => insert("refusal_overturned", "changed my mind")).toThrow("UNIQUE constraint failed");
  });
});

describe("the finding tables", () => {
  test("hold a severity to critical, high or medium", () => {
    const f = floor();
    const round = reviewIn(f.db, "order-1", f.operator);
    const finding = raiseOrderFinding(
      f.db,
      "order-1",
      { dimension: "docs", summary: "stale" },
      round.reviewer,
    );
    f.db.run("UPDATE factory_order_finding SET severity = 'high' WHERE id = ?", [finding]);
    expect(() =>
      f.db.run("UPDATE factory_order_finding SET severity = 'low' WHERE id = ?", [finding]),
    ).toThrow("CHECK constraint failed");
  });

  test("refuse a not_addressed or refusal_contested ruling without a reason", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    for (const ruling of ["not_addressed", "refusal_contested"]) {
      expect(() =>
        f.db.run(
          `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, worker, ruled_at)
           VALUES (?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
          [finding, openRound(f), ruling, reviewer],
        ),
      ).toThrow("CHECK constraint failed");
    }
  });

  test("refuse a blank reason and a second ruling from one round", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    const insert = (ruling: string, reason: string) =>
      f.db.run(
        `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, reason, worker, ruled_at)
         VALUES (?, ?, ?, ?, ?, '2026-09-26T10:00:00.000Z')`,
        [finding, openRound(f), ruling, reason, reviewer],
      );
    expect(() => insert("not_addressed", " ")).toThrow("CHECK constraint failed");
    insert("not_addressed", "still no test");
    expect(() => insert("addressed", "")).toThrow("UNIQUE constraint failed");
  });

  test("refuse a ruling outside the four", () => {
    const f = floor();
    const { finding, reviewer } = answered(f, "fixed");
    expect(() =>
      f.db.run(
        `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, reason, worker, ruled_at)
         VALUES (?, ?, 'partly_addressed', 'half', ?, '2026-09-26T10:00:00.000Z')`,
        [finding, openRound(f), reviewer],
      ),
    ).toThrow("CHECK constraint failed");
  });

  test("keep rulings and owner decisions through rebuild", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-ruling-"));
    const environment = { HOME: home, DIM_HOME: home };
    const f = floor(openDb(dbPath(environment)), false);
    const { finding, reviewer } = answered(f, "refused");
    ruleOnOrderFinding(f.db, finding, { ruling: "refusal_contested", reason: "in scope" }, reviewer);
    decideOrderRefusal(f.db, finding, { decision: "refusal_upheld", reason: "later" }, f.operator);
    closeDb(f.db);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(findingStanding(rebuilt, finding)).toMatchObject({
      ruling: "refusal_contested",
      decision: "refusal_upheld",
      state: "settled",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });
});
