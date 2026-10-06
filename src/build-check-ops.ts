import type { Database } from "bun:sqlite";
import { buildCheckVerdict } from "./build-check";
import { refuseBuild } from "./build-check-contract";
import { judge } from "./check-ops";
import { checkTask } from "./declared-tasks";
import { isClean, tipOf } from "./git";
import type { Later } from "./order-contract";
import { recordAt, recordStop } from "./order-ops";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";
import type { Workspace } from "./workspace";

export type BuildChecking = {
  readonly trace: Trace;
  readonly order: string;
  readonly workspace: Workspace;
  readonly env: Env;
  readonly cause: number;
};

export function checkBuild(db: Database, { trace, order, workspace, env, cause }: BuildChecking): void {
  const record = (later: Later) =>
    recordAt(trace, db, { order, station: "build", by: { kind: "factory", cause }, later: () => later });
  const head = tipOf(workspace.dir, workspace.branch);
  const task = checkTask(workspace.dir);
  if (task === null)
    recordStop({
      record,
      order,
      stop: { action: "build_refused", code: "no_check", details: { head } },
      refuse: refuseBuild,
    });
  const check = judge(trace, workspace.dir, task.commandLine, env);
  const verdict = buildCheckVerdict(head, check, isClean(workspace.dir, "all"));
  if (verdict.action === "build_refused") recordStop({ record, order, stop: verdict, refuse: refuseBuild });
  record(verdict);
}
