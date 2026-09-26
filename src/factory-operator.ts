import type { Database } from "bun:sqlite";

export class OperatorActionRefused extends Error {
  constructor(
    readonly code: "worker_not_operator",
    message: string,
  ) {
    super(message);
  }
}

export function assertOperator(db: Database, worker: string, action: string): void {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator") {
    throw new OperatorActionRefused(
      "worker_not_operator",
      `${worker} cannot ${action}; the operator delegates it`,
    );
  }
}
