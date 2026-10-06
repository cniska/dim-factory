import { isRefusal } from "./coded-error";
import { readGateChoice, readProjectConfig } from "./config";
import { checkTask, installCommand } from "./declared-tasks";
import { type Health, refusedHealth } from "./doctor-contract";
import { ecosystemsOf } from "./ecosystems";
import { type GatePlan, hooksWired, planGates, runsHooks } from "./gates";
import { type GateName, refuseGates } from "./gates-contract";
import { identityOf } from "./git";
import type { Env } from "./paths";
import { checkoutAt, defaultBranch } from "./project";
import { pinnedToolchain } from "./toolchain-ops";

function judged(name: string, judge: () => Health): Health {
  try {
    return judge();
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return refusedHealth(name, error);
  }
}

function project(root: string): Health {
  const found = checkoutAt(root);
  return found === null
    ? {
        name: "project",
        state: "fail",
        detail: `${root}'s origin remote names no owner/repo, so no order can belong to it`,
        fix: "git remote add origin <url of the project's repository>",
      }
    : { name: "project", state: "ok", detail: found.project };
}

function shipping(root: string): Health {
  const name = "ship";
  const branch = defaultBranch(root);
  if (branch === null) {
    return {
      name,
      state: "fail",
      detail: `${root} has no origin/HEAD, so no default branch to read the project's settings from or ship to`,
      fix: "git remote set-head origin --auto",
    };
  }
  const { ship } = readProjectConfig(root, branch);
  return ship === undefined
    ? {
        name,
        state: "fail",
        detail: `${branch} commits no ship setting, so no order in ${root} can ship`,
        fix: `dim config set ship default-branch --project, then commit .dim/config.json on ${branch}`,
      }
    : { name, state: "ok", detail: `orders ship by ${ship}` };
}

function identity(root: string, env: Env): Health {
  const found = identityOf(root, env);
  return found === null
    ? {
        name: "identity",
        state: "fail",
        detail: `git names no user.name and user.email in ${root}, and every factory commit carries the owner's identity`,
        fix: "ask the owner to set user.name and user.email with git config --global",
      }
    : { name: "identity", state: "ok", detail: `${found.name} <${found.email}>` };
}

function check(root: string): Health {
  const task = checkTask(root);
  return task === null
    ? {
        name: "check",
        state: "fail",
        detail: `${root} declares no check, so no slice can be judged`,
        fix: "stop and ask the owner which declared task is the project's check, then dim config set tasks.check <task> --project",
      }
    : { name: "check", state: "ok", detail: `${task.commandLine}, from ${task.source}` };
}

function dependencies(root: string): Health {
  const install = installCommand(root);
  if (install !== null) return { name: "dependencies", state: "ok", detail: `${install.commandLine}` };
  return ecosystemsOf(root).includes("javascript")
    ? {
        name: "dependencies",
        state: "fail",
        detail: `${root} tracks a JavaScript manifest but no lockfile, so a workspace cannot install its dependencies frozen`,
        fix: "commit the lockfile the project's package manager writes",
      }
    : { name: "dependencies", state: "ok", detail: "nothing to install" };
}

function toolchain(root: string, env: Env): Health {
  const pinned = pinnedToolchain(root, env);
  return pinned.kind === "failed"
    ? {
        name: "toolchain",
        state: "fail",
        detail: `\`mise bin-paths\` failed in ${root}: ${pinned.output.trim()}`,
        fix: "mise install, from the project's checkout",
      }
    : { name: "toolchain", state: "ok", detail: `${pinned.bins.length} pinned tool directories` };
}

function gates(root: string): Health {
  const chosen: readonly GateName[] | null = readGateChoice(root);
  if (chosen === null) return refusedHealth("gates", refuseGates("no_gates_chosen", { root }));
  const plans: GatePlan[] = planGates(root, chosen);
  const unmet = plans.filter((plan) => plan.state !== "installed" && plan.state !== "ahead");
  const ahead = plans.filter((plan) => plan.state === "ahead");
  const unwired = runsHooks(chosen) && !hooksWired(root);
  if (unmet.length > 0 || unwired) {
    return {
      name: "gates",
      state: "fail",
      detail: [
        ...unmet.map((plan) => `${plan.target} ${plan.state}`),
        ...(unwired ? ["git hooks do not run from .githooks"] : []),
      ].join("; "),
      fix: `dim gates install, from ${root}`,
    };
  }
  if (ahead.length > 0) {
    return {
      name: "gates",
      state: "warn",
      detail: `${ahead.map((plan) => plan.target).join(", ")} ahead of this dim`,
      fix: "run a dim at least as new as the one that installed them",
    };
  }
  return {
    name: "gates",
    state: "ok",
    detail: `${root} runs the gates it chose: ${chosen.join(", ") || "none"}`,
  };
}

export function projectHealth(root: string, env: Env): Health[] {
  return [
    judged("project", () => project(root)),
    judged("ship", () => shipping(root)),
    judged("identity", () => identity(root, env)),
    judged("check", () => check(root)),
    judged("dependencies", () => dependencies(root)),
    judged("toolchain", () => toolchain(root, env)),
    judged("gates", () => gates(root)),
  ];
}
