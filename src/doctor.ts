import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CodedError } from "./coded-error";
import { PROJECT_CONFIG, projectConfigPath, userConfigPath } from "./config";
import { ConfigError } from "./config-error";
import { readJsonc } from "./config-jsonc-file";
import { recordVersion } from "./db";
import { SCHEMA_VERSION } from "./db-schema";
import { type CommentGate, commentGateFor } from "./gate-comment";
import { GATE_ERROR } from "./gate-contract";
import { type GatePlan, installedOwners, planCommitGate, sharedHooksDir } from "./gate-install";
import { unarmedCheckouts } from "./gate-push";
import { checkoutRoot } from "./git-checkout";
import { isHostQualified } from "./git-remote-slug";
import { harnessInstalled, installedHarnesses } from "./harness-installed";
import { type HookPlan, hookGaps, outdatedLabel } from "./hooks";
import { codexConfigPath, planCodexTrust, type TrustState } from "./hooks-codex-trust";
import { AGENT_LABEL, planAgent } from "./ingest-launchd";
import { TOOLS } from "./ingest-tools";
import { type Env, resolveHomeDir, spoolDir, tildePath } from "./paths";
import { planRules } from "./rules";
import { planSkill, retiredLinks } from "./skill";

export type Health = { name: string; state: "ok" | "warn" | "fail"; detail: string; fix?: string };

const HOUR_MS = 3_600_000;
const SYNC_STOPPED_AFTER_MS = 24 * HOUR_MS;
const SESSION_SETTLED_HOURS = 2;
const BROKEN_HOOK_END_SHARE = 0.5;
const CLAUDE_CODE_DEFAULT_CLEANUP_DAYS = 30;
const RETENTION_WANTED_DAYS = 365;
const SPOOL_BEHIND_EVENTS = 200;

function scalar(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}

function text(db: Database, sql: string): string | null {
  return db.query<{ v: string | null }, []>(sql).get()?.v ?? null;
}

function unreadable(name: string, error: ConfigError): Health {
  return { name, state: "fail", detail: error.message, fix: `repair ${error.path} by hand` };
}

type HookRead =
  | { read: true; harnesses: number; missing: HookPlan[]; stale: HookPlan[] }
  | { read: false; error: ConfigError };

function readHooks(env: Env): HookRead {
  try {
    return { read: true, harnesses: installedHarnesses(env).length, ...hookGaps(env) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
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
      fix: "install codex or claude, then dim hooks install",
    };
  }
  if (hooks.missing.length === 0 && hooks.stale.length === 0) {
    return { name: "hooks", state: "ok", detail: "installed" };
  }
  const counts = [
    hooks.missing.length > 0 &&
      `${hooks.missing.length} missing (${hooks.missing.map((p) => p.event).join(", ")})`,
    hooks.stale.length > 0 &&
      `${hooks.stale.length} out of date (${hooks.stale.map(outdatedLabel).join(", ")})`,
  ].filter((c): c is string => c !== false);
  return {
    name: "hooks",
    state: "fail",
    detail: `session hooks: ${counts.join("; ")}`,
    fix: "dim hooks install",
  };
}

function codexTrust(env: Env): Health {
  if (!harnessInstalled("codex", env)) {
    return { name: "codex trust", state: "ok", detail: "codex is not installed" };
  }
  let untrusted: TrustState[];
  try {
    untrusted = planCodexTrust(env).filter((t) => !t.recorded);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return unreadable("codex trust", error);
  }
  if (untrusted.length === 0) {
    return {
      name: "codex trust",
      state: "ok",
      detail: "every codex hook has a trust recorded for its position",
    };
  }
  return {
    name: "codex trust",
    state: "fail",
    detail:
      `${untrusted.length} codex hooks have no trusted_hash under [hooks.state] ` +
      `(${untrusted.map((t) => t.key ?? `${t.event}, not in hooks.json`).join("; ")})`,
    fix: `start a codex session and approve the hook, or remove the stale keys from ${codexConfigPath(env)}`,
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
      detail: `only ${ended} of ${judgeable} sessions that ran since the hooks went in recorded an end`,
      fix: RUNS,
    };
  }
  return {
    name,
    state: "ok",
    detail: `${ended} of ${judgeable} sessions since the hooks went in recorded an end`,
  };
}

function launchdLoaded(): boolean {
  const uid = Bun.spawnSync(["id", "-u"], { stdout: "pipe" });
  const who = new TextDecoder().decode(uid.stdout).trim();
  return Bun.spawnSync(["launchctl", "print", `gui/${who}/${AGENT_LABEL}`], {
    stdout: "pipe",
    stderr: "pipe",
  }).success;
}

function retention(env: Env): Health {
  const path = join(resolveHomeDir(env), ".claude", "settings.json");
  let days: unknown;
  try {
    days = readJsonc<Record<string, unknown>>(path)?.cleanupPeriodDays;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
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
  const root = spoolDir(env);
  let waiting = 0;
  for (const tool of TOOLS) {
    const dir = join(root, tool);
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

const REINSTALL_GATE = "dim gate install --owner <host>/<account>";

function gateFailure(name: string, error: unknown): Health | null {
  if (!(error instanceof CodedError)) return null;
  if (error.code === GATE_ERROR.gitConfigUnreadable) return { name, state: "fail", detail: error.message };
  if (error.code === GATE_ERROR.unreadableOwners) {
    return { name, state: "fail", detail: error.message, fix: REINSTALL_GATE };
  }
  return null;
}

function commentGate(env: Env, cwd: string, commitGate: Health): Health {
  const name = "comment gate";
  const root = checkoutRoot(cwd);
  let gate: CommentGate;
  try {
    gate = root === null ? { state: "unlabeled" } : commentGateFor(root, "HEAD", env);
  } catch (error) {
    const failed = gateFailure(name, error);
    if (failed !== null) return failed;
    if (!(error instanceof ConfigError)) throw error;
    if (root !== null && error.path.startsWith(projectConfigPath(root))) {
      return { name, state: "fail", detail: error.message, fix: `repair ${PROJECT_CONFIG} and commit it` };
    }
    return unreadable(name, error);
  }
  if (gate.state === "unlabeled") {
    return {
      name,
      state: "ok",
      detail: `not judged: ${tildePath(cwd, env)} is not a checkout with a remote`,
    };
  }
  const { label } = gate;
  if (gate.state === "off") {
    return {
      name,
      state: "ok",
      detail: `off for ${label}: ${PROJECT_CONFIG} as HEAD commits it, over ${tildePath(userConfigPath(env), env)}, does not ban comments`,
    };
  }
  if (gate.state === "uncovered") {
    return {
      name,
      state: "warn",
      detail: `comments are banned for ${label}, but no installed pre-commit hook covers its origin, so nothing refuses them`,
      fix: REINSTALL_GATE,
    };
  }
  if (commitGate.state !== "ok") {
    return { name, state: "warn", detail: `banned for ${label}, not on until the commit gate is` };
  }
  if (gate.state === "hooks-elsewhere") {
    return {
      name,
      state: "warn",
      detail: `comments are banned for ${label}, but git runs its hooks from ${gate.hooksPath === null ? "the repository's own hooks directory" : tildePath(gate.hooksPath, env)} rather than ${tildePath(sharedHooksDir(env), env)}, so nothing refuses them`,
    };
  }
  return {
    name,
    state: "ok",
    detail: `on for ${label}: a comment added to a JS or TS file is refused at commit`,
  };
}

function dimOnPath(): Health {
  return Bun.which("dim")
    ? { name: "path", state: "ok", detail: `dim resolves to ${Bun.which("dim")}` }
    : {
        name: "path",
        state: "fail",
        detail: "dim is not on PATH, so no agent can reach it from another repo",
        fix: "bun link, from this repo",
      };
}

function schema(db: Database): Health {
  const version = recordVersion(db);
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
  const settled = `last_seen_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-${SESSION_SETTLED_HOURS} hours')`;
  const judgeable = since
    ? scalar(
        db,
        `SELECT count(*) AS n FROM session
         WHERE parent_id IS NULL AND started_at >= '${since}'
           AND ${settled}`,
      )
    : 0;
  const ended = since
    ? scalar(
        db,
        `SELECT count(*) AS n FROM session
         WHERE parent_id IS NULL AND started_at >= '${since}' AND end_reason IS NOT NULL
           AND ${settled}`,
      )
    : 0;
  return judgeEnds(hooks, since, judgeable, ended);
}

function skill(env: Env): Health {
  const pendingLinks = planSkill(env).filter((p) => p.state !== "linked");
  const retired = retiredLinks(env);
  return pendingLinks.length === 0 && retired.length === 0
    ? { name: "skill", state: "ok", detail: "every skill linked for every tool" }
    : {
        name: "skill",
        state: "warn",
        detail: [
          ...(pendingLinks.length > 0
            ? [`${pendingLinks.length} of ${planSkill(env).length} skill links missing`]
            : []),
          ...(retired.length > 0 ? [`links to skills that no longer ship: ${retired.join(", ")}`] : []),
        ].join("; "),
        fix: "dim skills install",
      };
}

function commitGate(env: Env): Health {
  try {
    return commitGateHealth(planCommitGate(installedOwners(env) ?? [], [], env), sharedHooksDir(env));
  } catch (error) {
    const failed = gateFailure("commit gate", error);
    if (failed === null) throw error;
    return failed;
  }
}

function commitGateHealth(plan: GatePlan, dir: string): Health {
  const gaps = plan.hooks
    .filter((h) => h.state !== "installed")
    .map((h) => `${h.name} is ${h.state}`)
    .concat(
      plan.globalHooksPath === dir
        ? []
        : [`git's global core.hooksPath is ${plan.globalHooksPath ?? "unset"} rather than ${dir}`],
    );
  return gaps.length === 0
    ? { name: "commit gate", state: "ok", detail: "every hook in place, for every repo" }
    : {
        name: "commit gate",
        state: "warn",
        detail: `${gaps.join(", ")}; those rules are held only where a repo gates its own`,
        fix: "dim gate install --owner <owner>",
      };
}

function gateOwners(env: Env): Health[] {
  try {
    const owners = installedOwners(env);
    return owners === null ? [] : ownersHealth(owners);
  } catch (error) {
    const failed = gateFailure("gate owners", error);
    if (failed === null) throw error;
    return [failed];
  }
}

function ownersHealth(owners: readonly string[]): Health[] {
  const bareOwners = owners.filter((owner) => !isHostQualified(owner));
  if (bareOwners.length === 0) {
    return [
      {
        name: "gate owners",
        state: "ok",
        detail: `${owners.length} owners, each naming a host and an account`,
      },
    ];
  }
  return [
    {
      name: "gate owners",
      state: "fail",
      detail: `${bareOwners.length} owners name an account but no host (${bareOwners.join(", ")}), so the gate arms nowhere`,
      fix: REINSTALL_GATE,
    },
  ];
}

function pushGate(db: Database, env: Env): Health {
  const unarmed = unarmedCheckouts(
    db
      .query<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit ORDER BY repo")
      .all()
      .map((r) => r.repo)
      .filter((repo) => existsSync(join(repo, ".git"))),
  );
  return unarmed.length === 0
    ? { name: "push gate", state: "ok", detail: "every checkout names the branch the gate protects" }
    : {
        name: "push gate",
        state: "warn",
        detail: `${unarmed.length} checkouts have no origin/HEAD, so the push gate exits before reading anything there: ${unarmed
          .map((d) => d.replace(`${resolveHomeDir(env)}/`, ""))
          .join(", ")}`,
        fix: "git remote set-head origin -a, in each",
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

function rules(env: Env): Health {
  const plan = planRules(env);
  if (plan.state === "not-installed") {
    return { name: "rules", state: "ok", detail: "codex is not installed, so it needs no rules file" };
  }
  if (plan.state === "missing-source")
    return { name: "rules", state: "warn", detail: `no ${plan.source} to flatten` };
  if (plan.state === "unchanged")
    return { name: "rules", state: "ok", detail: "codex rules match the canonical file" };
  const detail =
    plan.state === "absent"
      ? "codex has no rules file, so none of the conventions reach it"
      : "codex rules differ from the canonical file";
  return { name: "rules", state: "fail", detail, fix: "dim rules install" };
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

export function diagnose(db: Database, env: Env, cwd: string): Health[] {
  const hooks = readHooks(env);
  const commit = commitGate(env);
  return [
    dimOnPath(),
    schema(db),
    freshness(db),
    sessionHooks(hooks),
    codexTrust(env),
    endReasons(db, hooks),
    skill(env),
    commit,
    ...gateOwners(env),
    commentGate(env, cwd, commit),
    pushGate(db, env),
    agent(env),
    rules(env),
    retention(env),
    spool(env),
    outcomes(db),
  ];
}
