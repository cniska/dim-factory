import type { Command } from "./cli-contract";

const LOADERS: Record<string, () => Promise<Command>> = {
  sync: () => import("./sync-command").then((m) => m.syncCommand),
  rebuild: () => import("./rebuild-command").then((m) => m.rebuildCommand),
  doctor: () => import("./doctor-command").then((m) => m.doctorCommand),
  query: () => import("./query-command").then((m) => m.queryCommand),
  sql: () => import("./sql-command").then((m) => m.sqlCommand),
  config: () => import("./config-command").then((m) => m.configCommand),
  comments: () => import("./comments-command").then((m) => m.commentsCommand),
  gate: () => import("./gate-command").then((m) => m.gateCommand),
  hooks: () => import("./hooks-command").then((m) => m.hooksCommand),
  skills: () => import("./skills-command").then((m) => m.skillsCommand),
  rules: () => import("./rules-command").then((m) => m.rulesCommand),
  agent: () => import("./agent-command").then((m) => m.agentCommand),
  trace: () => import("./trace-command").then((m) => m.traceCommand),
};

export function findCommand(name: string | undefined): Promise<Command> | undefined {
  return name !== undefined && Object.hasOwn(LOADERS, name) ? LOADERS[name]?.() : undefined;
}

export function allCommands(): Promise<Command[]> {
  return Promise.all(Object.values(LOADERS).map((load) => load()));
}
