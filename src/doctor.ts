import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { invariant } from "./assert";
import { type CodedError, isRefusal } from "./coded-error";
import { readGateChoice, readProjectConfig } from "./config";
import { type ConfigRefusal, isConfigRefusal } from "./config-error";
import { readJsonc } from "./config-jsonc-file";
import { recordVersion } from "./db";
import { SCHEMA_VERSION } from "./db-schema";
import { type GatePlan, hooksWired, planGates, runsHooks } from "./gates";
import { type GateName, refuseGates } from "./gates-contract";
import { checkoutRoot } from "./git-checkout";
import { HARNESSES } from "./harness-contract";
import { installedHarnesses } from "./harness-ops";
import { type HookPlan, hookGaps, outdatedLabel } from "./hooks";
import { AGENT_LABEL, planAgent } from "./ingest-launchd";
import { toolSpoolDir } from "./ingest-spool";
import type { Env } from "./paths";
import { defaultBranch } from "./project";
import { scalar } from "./query";
import { planSkill, retiredLinks } from "./skill";

export type Health = { name: string; state: "ok" | "warn" | "fail"; detail: string; fix?: string };

const HOUR_MS = 3_600_000;
const SYNC_STOPPED_AFTER_MS = 24 * HOUR_MS;
const SESSION_SETTLED_HOURS = 2;
const BROKEN_HOOK_END_SHARE = 0.5;
const CLAUDE_CODE_DEFAULT_CLEANUP_DAYS = 30;
const RETENTION_WANTED_DAYS = 365;
const SPOOL_BEHIND_EVENTS = 200;

function text(db: Database, sql: string): string | null {
  const row = db.query<{ v: string | null }, []>(sql).get();
  invariant(row !== null, `an aggregate returns one row: ${sql}`);
  return row.v;
}

function notJudged(name: string, version: number): Health {
  return {
    name,
    state: "warn",
    detail: `not judged; the record is version ${version}, which this build does not read`,
  };
}

function unreadable(name: string, error: ConfigRefusal): Health {
  return { name, state: "fail", detail: error.message, fix: `repair ${error.meta.path} by hand` };
}

type HookRead =
  | { read: true; harnesses: number; missing: HookPlan[]; stale: HookPlan[]; retired: HookPlan[] }
  | { read: false; error: ConfigRefusal };

function readHooks(env: Env): HookRead {
  try {
    return { read: true, harnesses: installedHarnesses(env).length, ...hookGaps(env) };
  } catch (error) {
    if (!isConfigRefusal(error)) throw error;
    return { read: false, error };
  }
}

function sessionHooks(hooks: HookRead): Health {
  if (!hooks.read) return unreadable("hooks", hooks.error);
  if (hooks.harnesses === 0) {
    return {
      name: "hooks",
      state: "warn",
      detail: "no harness is installed, so no session hook is written and nothing is recorded",
      fix: "install claude, then dim hooks install",
    };
  }
  if (hooks.missing.length === 0 && hooks.stale.length === 0 && hooks.retired.length === 0) {
    return { name: "hooks", state: "ok", detail: "installed" };
  }
  const counts = [
    hooks.missing.length > 0 &&
      `${hooks.missing.length} missing (${hooks.missing.map((p) => p.event).join(", ")})`,
    hooks.stale.length > 0 &&
      `${hooks.stale.length} out of date (${hooks.stale.map(outdatedLabel).join(", ")})`,
    hooks.retired.length > 0 &&
      `${hooks.retired.length} retired (${hooks.retired.map((p) => `${p.event}: ${p.kind}`).join(", ")})`,
  ].filter((c): c is string => c !== false);
  return {
    name: "hooks",
    state: "fail",
    detail: `session hooks: ${counts.join("; ")}`,
    fix: "dim hooks install",
  };
}

function judgeEnds(hooks: HookRead, since: string | null, judgeable: number, ended: number): Health {
  const name = "end reasons";
  const RUNS = "check the hook command runs: it must write to the spool and exit 0";
  if (!hooks.read) {
    return { name, state: "warn", detail: "not judged; the hook config could not be read" };
  }
  if (hooks.harnesses === 0 || hooks.missing.length > 0) {
    return { name, state: "warn", detail: "not expected yet; the hooks are not installed" };
  }
  if (!since) {
    return {
      name,
      state: "fail",
      detail: "the hooks are installed but have never written an event",
      fix: RUNS,
    };
  }
  if (judgeable === 0) {
    return {
      name,
      state: "ok",
      detail: "no session has both started and finished since the hooks went in",
    };
  }
  if (ended / judgeable < BROKEN_HOOK_END_SHARE) {
    return {
      name,
      state: "fail",
      detail: `only ${ended} of ${judgeable} sessions whose start hook fired recorded an end`,
      fix: RUNS,
    };
  }
  return {
    name,
    state: "ok",
    detail: `${ended} of ${judgeable} sessions whose start hook fired recorded an end`,
  };
}

function launchdLoaded(): boolean {
  const uid = process.getuid?.();
  invariant(uid !== undefined, "launchd runs only where processes have a user id");
  return Bun.spawnSync(["launchctl", "print", `gui/${uid}/${AGENT_LABEL}`], {
    stdout: "pipe",
    stderr: "pipe",
  }).success;
}

const ClaudeSettings = z.looseObject({ cleanupPeriodDays: z.unknown().optional() });

function retention(env: Env): Health {
  const path = HARNESSES.claude.hookConfig(env);
  let days: unknown;
  try {
    days = readJsonc(path, ClaudeSettings)?.cleanupPeriodDays;
  } catch (error) {
    if (!isConfigRefusal(error)) throw error;
    return unreadable("retention", error);
  }
  if (typeof days !== "number") {
    return {
      name: "retention",
      state: "fail",
      detail: `cleanupPeriodDays is unset, so Claude Code deletes transcripts after ${CLAUDE_CODE_DEFAULT_CLEANUP_DAYS} days`,
      fix: `set "cleanupPeriodDays" in ${path}`,
    };
  }
  return {
    name: "retention",
    state: days >= RETENTION_WANTED_DAYS ? "ok" : "warn",
    detail: `transcripts kept ${days} days`,
  };
}

function spool(env: Env): Health {
  let waiting = 0;
  for (const harness of Object.values(HARNESSES)) {
    const dir = toolSpoolDir(harness.name, env);
    if (existsSync(dir)) waiting += readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }
  if (waiting === 0) return { name: "spool", state: "ok", detail: "no hook events waiting" };
  return {
    name: "spool",
    state: waiting > SPOOL_BEHIND_EVENTS ? "warn" : "ok",
    detail: `${waiting} hook events written but not yet read`,
    fix: waiting > SPOOL_BEHIND_EVENTS ? "dim sync" : undefined,
  };
}

function dimOnPath(): Health {
  const dim = Bun.which("dim");
  return dim
    ? { name: "path", state: "ok", detail: `dim resolves to ${dim}` }
    : {
        name: "path",
        state: "fail",
        detail: "dim is not on PATH, so no agent can reach it from another repo",
        fix: "bun link, from this repo",
      };
}

function schema(version: number): Health {
  return version === SCHEMA_VERSION
    ? { name: "schema", state: "ok", detail: `version ${version}` }
    : {
        name: "schema",
        state: "fail",
        detail: `database is version ${version}, this build expects ${SCHEMA_VERSION}`,
        fix: "dim rebuild",
      };
}

function freshness(db: Database): Health {
  const last = text(db, "SELECT max(ingested_at) AS v FROM source_file");
  if (last === null)
    return { name: "freshness", state: "fail", detail: "nothing has ever been read", fix: "dim sync" };
  const age = Date.now() - Date.parse(last);
  const detail = `last read ${Math.round(age / HOUR_MS)} hours ago`;
  if (age > SYNC_STOPPED_AFTER_MS) return { name: "freshness", state: "warn", detail, fix: "dim sync" };
  return { name: "freshness", state: "ok", detail };
}

function endReasons(db: Database, hooks: HookRead): Health {
  const since = text(db, "SELECT min(ts) AS v FROM hook_event");
  const hooked = `parent_id IS NULL AND started_at >= ?
    AND last_seen_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${SESSION_SETTLED_HOURS} hours')
    AND id IN (SELECT session_id FROM hook_event WHERE event = 'session_start')`;
  const judgeable = since ? scalar(db, `SELECT count(*) AS n FROM session WHERE ${hooked}`, [since]) : 0;
  const ended = since
    ? scalar(db, `SELECT count(*) AS n FROM session WHERE ${hooked} AND end_reason IS NOT NULL`, [since])
    : 0;
  return judgeEnds(hooks, since, judgeable, ended);
}

function skill(env: Env): Health {
  const links = planSkill(env);
  const pendingLinks = links.filter((p) => p.state !== "linked");
  const retired = retiredLinks(env);
  return pendingLinks.length === 0 && retired.length === 0
    ? { name: "skill", state: "ok", detail: "every skill linked for every tool" }
    : {
        name: "skill",
        state: "warn",
        detail: [
          ...(pendingLinks.length > 0
            ? [`${pendingLinks.length} of ${links.length} skill links missing`]
            : []),
          ...(retired.length > 0 ? [`links to skills that no longer ship: ${retired.join(", ")}`] : []),
        ].join("; "),
        fix: "dim skills install",
      };
}

function agent(env: Env): Health {
  const plan = planAgent(env);
  const plist = plan.path;
  if (!existsSync(plist)) {
    return {
      name: "agent",
      state: "warn",
      detail: "no launchd agent, so syncing is manual",
      fix: "dim agent install",
    };
  }
  if (!plan.unchanged) {
    return {
      name: "agent",
      state: "warn",
      detail: "launchd agent points to a different checkout or Bun path",
      fix: "dim agent install, then reload the launchd agent",
    };
  }
  if (launchdLoaded()) return { name: "agent", state: "ok", detail: "launchd agent loaded" };
  return {
    name: "agent",
    state: "warn",
    detail: "launchd agent is written but not loaded",
    fix: `launchctl bootstrap gui/$(id -u) ${plist}`,
  };
}

function outcomes(db: Database): Health {
  const commits = scalar(db, "SELECT count(*) AS n FROM repo_commit");
  return commits === 0
    ? {
        name: "outcomes",
        state: "warn",
        detail: "no commits read, so nothing here can say whether work was right",
        fix: "dim sync, from a machine holding the repos",
      }
    : { name: "outcomes", state: "ok", detail: `${commits} commits read from the repos on disk` };
}

function refused(error: CodedError, name = "gates"): Health {
  return { name, state: "fail", detail: error.message, fix: error.resolve };
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
  let ship: string | undefined;
  try {
    ship = readProjectConfig(root, branch).ship;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return refused(error, name);
  }
  return ship === undefined
    ? {
        name,
        state: "fail",
        detail: `${branch} commits no ship setting, so no order in ${root} can ship`,
        fix: `dim config set ship default-branch --project, then commit .dim/config.json on ${branch}`,
      }
    : { name, state: "ok", detail: `orders ship by ${ship}` };
}

function gates(root: string): Health {
  let chosen: readonly GateName[] | null;
  let plans: GatePlan[];
  try {
    chosen = readGateChoice(root);
    if (chosen === null) return refused(refuseGates("no_gates_chosen", { root }));
    plans = planGates(root, chosen);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return refused(error);
  }
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

export function diagnose(db: Database, env: Env, cwd: string): Health[] {
  const hooks = readHooks(env);
  const version = recordVersion(db);
  const readable = version === SCHEMA_VERSION;
  const project = checkoutRoot(cwd);
  return [
    dimOnPath(),
    schema(version),
    readable ? freshness(db) : notJudged("freshness", version),
    sessionHooks(hooks),
    readable ? endReasons(db, hooks) : notJudged("end reasons", version),
    skill(env),
    agent(env),
    retention(env),
    spool(env),
    readable ? outcomes(db) : notJudged("outcomes", version),
    ...(project === null ? [] : [gates(project), shipping(project)]),
  ];
}
