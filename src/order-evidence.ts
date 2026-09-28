import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { currentOrderCommits } from "./order-commits";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { assertOrderRunning } from "./order-status";
import type { Rewrite } from "./ship-rebase";
import type { WorkerHookReport } from "./worker-environment";

export function recordOrderCommit(
  db: Database,
  orderId: string,
  sha: string,
  worker: string,
  subject: string,
  at = now(),
): number {
  assertOrderRunning(db, orderId);
  return writeTransaction(db, () => {
    db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
      orderId,
      sha,
      subject,
      at,
    ]);
    return appendOrderEventInTransaction(db, orderId, { kind: "commit_created", worker, commitSha: sha }, at);
  });
}

export type OrderFile = { path: string; added: number | null; removed: number | null };

export function recordOrderFile(
  db: Database,
  orderId: string,
  file: OrderFile,
  worker: string,
  at = now(),
): void {
  assertOrderRunning(db, orderId);
  db.run(
    `INSERT INTO factory_order_file (order_id, worker, path, added, removed, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (order_id, path) DO UPDATE SET
       worker = excluded.worker,
       added = added + excluded.added,
       removed = removed + excluded.removed,
       recorded_at = excluded.recorded_at`,
    [orderId, worker, file.path, file.added, file.removed, at],
  );
}

export type OrderCheck = {
  command: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  result: string;
};

export function recordOrderCheckInTransaction(
  db: Database,
  orderId: string,
  check: OrderCheck,
  headSha: string,
  at: string,
): number {
  const result = db.run(
    `INSERT INTO factory_order_check
       (order_id, head_sha, command, exit_code, started_at, finished_at, result, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, headSha, check.command, check.exitCode, check.startedAt, check.finishedAt, check.result, at],
  );
  return Number(result.lastInsertRowid);
}

export function recordOrderCheck(
  db: Database,
  orderId: string,
  check: OrderCheck,
  headSha: string,
  at = now(),
): number {
  assertOrderRunning(db, orderId);
  return recordOrderCheckInTransaction(db, orderId, check, headSha, at);
}

export function recordRewrittenCommits(
  db: Database,
  orderId: string,
  shipRun: number,
  rewrite: Pick<Rewrite, "commits">,
  at: string,
): void {
  const current = currentOrderCommits(db, orderId);
  for (const { from, to } of rewrite.commits) {
    const recorded = current.find((row) => from.startsWith(row.sha.toLowerCase()));
    if (!recorded) continue;
    db.run(
      `INSERT INTO factory_order_commit (order_id, sha, subject, ship_run_id, retires, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, to, recorded.subject, shipRun, recorded.sha, at],
    );
  }
}

export function recordOrderEnvironment(
  db: Database,
  orderId: string,
  report: WorkerHookReport,
  at = now(),
): void {
  assertOrderRunning(db, orderId);
  insertOrderEnvironment(db, orderId, report, at);
}

export function insertOrderEnvironment(
  db: Database,
  orderId: string,
  report: WorkerHookReport,
  at: string,
): void {
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
