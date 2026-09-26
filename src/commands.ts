import { benchCommand } from "./bench-command";
import { checkCommandCommand } from "./check-command-command";
import { checkCommitsCommand } from "./check-commits-command";
import type { Command } from "./command";
import { commentsCommand } from "./comments-command";
import { configCommand } from "./config-command";
import { doctorCommand } from "./doctor-command";
import { embedCommand } from "./embed-command";
import { factoryCommand } from "./factory-command";
import { findingCommand } from "./finding-command";
import { initCommand } from "./init-command";
import { installAgentCommand } from "./install-agent-command";
import { installCommitGateCommand } from "./install-commit-gate-command";
import { installHooksCommand } from "./install-hooks-command";
import { installRulesCommand } from "./install-rules-command";
import { installSkillCommand } from "./install-skill-command";
import { labelCommand } from "./label-command";
import { operatorCommand } from "./operator-command";
import { orderCommand } from "./order-command";
import { qCommand } from "./q-command";
import { rebuildCommand } from "./rebuild-command";
import { routeCommand } from "./route-command";
import { scheduleCommand } from "./schedule-command";
import { sqlCommand } from "./sql-command";
import { statsCommand } from "./stats-command";
import { syncCommand } from "./sync-command";
import { traceCommand } from "./trace-command";
import { wakeCommand } from "./wake-command";
import { wallCommand } from "./wall-command";
import { wtCommand } from "./wt-command";

export const COMMANDS: readonly Command[] = [
  initCommand,
  syncCommand,
  rebuildCommand,
  embedCommand,
  statsCommand,
  doctorCommand,
  qCommand,
  sqlCommand,
  configCommand,
  commentsCommand,
  checkCommandCommand,
  checkCommitsCommand,
  installHooksCommand,
  installAgentCommand,
  installRulesCommand,
  installSkillCommand,
  installCommitGateCommand,
  wakeCommand,
  wtCommand,
  orderCommand,
  operatorCommand,
  factoryCommand,
  scheduleCommand,
  routeCommand,
  traceCommand,
  wallCommand,
  labelCommand,
  findingCommand,
  benchCommand,
];

export function findCommand(name: string | undefined): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}
