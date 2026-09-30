import type { Command } from "./cli-contract";

const LOADERS: Record<string, () => Promise<Command>> = {
  sync: () => import("./sync-command").then((m) => m.syncCommand),
  rebuild: () => import("./rebuild-command").then((m) => m.rebuildCommand),
  doctor: () => import("./doctor-command").then((m) => m.doctorCommand),
  q: () => import("./q-command").then((m) => m.qCommand),
  sql: () => import("./sql-command").then((m) => m.sqlCommand),
  config: () => import("./config-command").then((m) => m.configCommand),
  comments: () => import("./comments-command").then((m) => m.commentsCommand),
  gate: () => import("./gate-command").then((m) => m.gateCommand),
  "check-command": () => import("./check-command-command").then((m) => m.checkCommandCommand),
  "check-commits": () => import("./check-commits-command").then((m) => m.checkCommitsCommand),
  "install-hooks": () => import("./install-hooks-command").then((m) => m.installHooksCommand),
  "install-agent": () => import("./install-agent-command").then((m) => m.installAgentCommand),
  "install-rules": () => import("./install-rules-command").then((m) => m.installRulesCommand),
  "install-skill": () => import("./install-skill-command").then((m) => m.installSkillCommand),
  "install-commit-gate": () =>
    import("./install-commit-gate-command").then((m) => m.installCommitGateCommand),
  wake: () => import("./wake-command").then((m) => m.wakeCommand),
  "format-edit": () => import("./format-edit-command").then((m) => m.formatEditCommand),
  wt: () => import("./wt-command").then((m) => m.wtCommand),
  trace: () => import("./trace-command").then((m) => m.traceCommand),
};

export function findCommand(name: string | undefined): Promise<Command> | undefined {
  return name !== undefined && Object.hasOwn(LOADERS, name) ? LOADERS[name]?.() : undefined;
}

export function allCommands(): Promise<Command[]> {
  return Promise.all(Object.values(LOADERS).map((load) => load()));
}
