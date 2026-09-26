import type { Database } from "bun:sqlite";
import { currentOrderCommits } from "./factory-order-commits";
import { appendOrderEventInTransaction, now } from "./factory-order-ledger";
import { assertOrderBuilding, assertOrderWorking } from "./factory-order-status";
import type { Rewrite } from "./rebase-onto-trunk";
import type { WorkerHookReport } from "./worker-environment";

export function recordOrderCommit(
  db: Database,
  orderId: string,
  sha: string,
  worker: string,
  subject?: string,
  at = now(),
): number {
  assertOrderBuilding(db, orderId);
  return db.transaction(() => {
    db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
      orderId,
      sha,
      subject ?? null,
      at,
    ]);
    return appendOrderEventInTransaction(db, orderId, { kind: "commit_created", worker, commitSha: sha }, at);
  })();
}

export type OrderFile = { path: string; added?: number; removed?: number };

export function recordOrderFile(
  db: Database,
  orderId: string,
  file: OrderFile,
  worker: string,
  at = now(),
): void {
  assertOrderBuilding(db, orderId);
  db.run(
    `INSERT INTO factory_order_file (order_id, worker, path, added, removed, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (order_id, path) DO UPDATE SET
       worker = excluded.worker,
       added = added + excluded.added,
       removed = removed + excluded.removed,
       recorded_at = excluded.recorded_at`,
    [orderId, worker, file.path, file.added ?? null, file.removed ?? null, at],
  );
}

export type OrderCheck = {
  command: string;
  exitCode: number;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
};

function recordOrderCheckInTransaction(
  db: Database,
  orderId: string,
  check: OrderCheck,
  worker: string,
  at: string,
): { checkId: number; eventId: number } {
  const result = db.run(
    `INSERT INTO factory_order_check (order_id, command, exit_code, started_at, finished_at, result, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      check.command,
      check.exitCode,
      check.startedAt ?? null,
      check.finishedAt ?? at,
      check.result ?? null,
      at,
    ],
  );
  const checkId = Number(result.lastInsertRowid);
  const eventId = appendOrderEventInTransaction(db, orderId, { kind: "check_finished", worker, checkId }, at);
  return { checkId, eventId };
}

export function recordOrderCheck(
  db: Database,
  orderId: string,
  check: OrderCheck,
  worker: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  return db.transaction(() => recordOrderCheckInTransaction(db, orderId, check, worker, at).eventId)();
}

export function recordOrderRewrite(
  db: Database,
  orderId: string,
  rewrite: Rewrite,
  check: OrderCheck,
  worker: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.transaction(() => {
    const current = currentOrderCommits(db, orderId);
    for (const { from, to } of rewrite.commits) {
      const recorded = current.find((row) => from.startsWith(row.sha.toLowerCase()));
      if (!recorded) continue;
      db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
        orderId,
        to,
        recorded.subject,
        at,
      ]);
      appendOrderEventInTransaction(
        db,
        orderId,
        { kind: "commit_rewritten", worker, commitSha: to, evidence: { from: recorded.sha } },
        at,
      );
    }
    const { checkId } = recordOrderCheckInTransaction(db, orderId, check, worker, at);
    db.run(
      `INSERT INTO factory_order_rewrite
         (order_id, old_base, new_base, old_head, new_head, patch_equal, check_id, worker, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        rewrite.oldBase,
        rewrite.newBase,
        rewrite.oldHead,
        rewrite.newHead,
        rewrite.patchEqual ? 1 : 0,
        checkId,
        worker,
        at,
      ],
    );
  })();
}

export function recordOrderEnvironment(
  db: Database,
  orderId: string,
  report: WorkerHookReport,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.run(
    `INSERT INTO factory_order_environment
       (order_id, phase, argv, exit_code, signal, stdout, stderr, resources, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      report.phase,
      JSON.stringify(report.argv),
      report.exitCode,
      report.signal,
      report.stdout,
      report.stderr,
      JSON.stringify(report.resources),
      at,
    ],
  );
}

export function recordOrderDocument(
  db: Database,
  orderId: string,
  path: string,
  worker: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.run("INSERT INTO factory_order_document (order_id, worker, path, recorded_at) VALUES (?, ?, ?, ?)", [
    orderId,
    worker,
    path,
    at,
  ]);
}
