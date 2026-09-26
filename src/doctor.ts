import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LABEL, agentPlistPath } from "./agent";
import { checkoutRoot } from "./checkout";
import { codexConfigPath, planCodexTrust, type TrustState } from "./codex-trust";
import {
  type CommentGate,
  commentGateFor,
  GitConfigUnreadable,
  installedOwners,
  planCommitGate,
  sharedHooksDir,
} from "./commit-gate";
import { PROJECT_CONFIG, projectConfigPath, userConfigPath } from "./config";
import { ConfigError } from "./config-error";
import { harnessCommand } from "./harness-command";
import { HARNESSES } from "./harness-name";
import { type HookPlan, hookGaps } from "./hooks";
import { readJsonc } from "./jsonc-file";
import { dataDir, type Env, resolveHomeDir, tildePath } from "./paths";
import { primaryCheckout } from "./primary-checkout";
import { unarmedCheckouts } from "./push-gate";
import { isHostQualified } from "./remote-slug";
import { RoutingError, readHarnessMap } from "./routing";
import { planRules } from "./rules";
import { SCHEMA_VERSION } from "./schema";
import { shipMethod } from "./ship-method";
import { planSkill, retiredLinks } from "./skill";
import { TOOLS } from "./tools";

export type Health = { name: string; state: "ok" | "warn" | "fail"; detail: string; fix?: string };

const HOUR_MS = 3_600_000;

function scalar(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | null)?.n ?? 0;
}

function text(db: Database, sql: string): string | null {
  return (db.prepare(sql).get() as { v: string | null } | null)?.v ?? null;
}

function unreadable(name: string, error: ConfigError): Health {
  return { name, state: "fail", detail: error.message, fix: `repair ${error.path} by hand` };
}

type HookRead = { read: true; missing: HookPlan[]; stale: HookPlan[] } | { read: false; error: ConfigError };

function readHooks(env: Env): HookRead {
  try {
    return { read: true, ...hookGaps(env) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { read: false, error };
  }
}

function sessionHooks(hooks: HookRead): Health {
  if (!hooks.read) return unreadable("hooks", hooks.error);
  if (hooks.missing.length === 0 && hooks.stale.length === 0) {
    return { name: "hooks", state: "ok", detail: "installed in both tools" };
  }
  const counts = [
    hooks.missing.length > 0 &&
      `${hooks.missing.length} missing (${hooks.missing.map((p) => p.event).join(", ")})`,
    hooks.stale.length > 0 &&
      `${hooks.stale.length} written against an older contract (${hooks.stale.map((p) => `${p.event}: ${p.installedVersion ?? "unmarked"}`).join(", ")})`,
  ].filter((c): c is string => c !== false);
  return {
    name: "hooks",
    state: "fail",
    detail: `session hooks: ${counts.join("; ")}`,
    fix: "dim install-hooks --write",
  };
}

function codexTrust(env: Env): Health {
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

function endReasons(hooks: HookRead, since: string | null, judgeable: number, ended: number): Health {
  const name = "end reasons";
  const RUNS = "check the hook command runs: it must write to the spool and exit 0";
  if (!hooks.read) {
    return { name, state: "warn", detail: "not judged; the hook config could not be read" };
  }
  if (hooks.missing.length > 0) {
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
  if (ended / judgeable < 0.5) {
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
      detail: "cleanupPeriodDays is unset, so Claude Code deletes transcripts after 30 days",
      fix: `set "cleanupPeriodDays" in ${path}`,
    };
  }
  return { name: "retention", state: days >= 365 ? "ok" : "warn", detail: `transcripts kept ${days} days` };
}

function spool(env: Env): Health {
  const root = join(dataDir(env), "spool");
  let waiting = 0;
  for (const tool of TOOLS) {
    const dir = join(root, tool);
    if (existsSync(dir)) waiting += readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }
  if (waiting === 0) return { name: "spool", state: "ok", detail: "no hook events waiting" };
  return {
    name: "spool",
    state: waiting > 200 ? "warn" : "ok",
    detail: `${waiting} hook events written but not yet read`,
    fix: waiting > 200 ? "dim sync" : undefined,
  };
}

function harnesses(env: Env): Health {
  const ready: string[] = [];
  const gaps: string[] = [];
  const repairs: string[] = [];
  for (const harness of HARNESSES) {
    const installed = Bun.which(harnessCommand(harness), { PATH: env.PATH ?? "" }) !== null;
    let mapped: boolean;
    try {
      readHarnessMap(harness, env);
      mapped = true;
    } catch (error) {
      if (error instanceof ConfigError) return unreadable("harnesses", error);
      if (!(error instanceof RoutingError)) throw error;
      if (error.kind !== "no-map") {
        return {
          name: "harnesses",
          state: "fail",
          detail: error.message,
          fix: `repair ${error.path} by hand`,
        };
      }
      mapped = false;
    }
    if (installed && mapped) ready.push(harness);
    else if (installed) {
      gaps.push(`${harness} is on PATH but routing.json has no ${harness} map`);
      repairs.push(`add a ${harness} map to routing.json`);
    } else if (mapped) {
      gaps.push(`${harness} is mapped in routing.json but not on PATH`);
      repairs.push(`install ${harness}, or remove its map`);
    }
  }
  if (ready.length === 0 && gaps.length === 0) {
    return {
      name: "harnesses",
      state: "warn",
      detail: "no harness is ready, so no station can start a worker",
      fix: "install codex or claude and map it in routing.json",
    };
  }
  const readiness = ready.length > 0 ? `${ready.join(", ")} ready` : "no harness is ready";
  if (gaps.length === 0) {
    return {
      name: "harnesses",
      state: "ok",
      detail: `${readiness}: each is on PATH and mapped in routing.json`,
    };
  }
  return {
    name: "harnesses",
    state: "warn",
    detail: `${readiness}; ${gaps.join("; ")}`,
    fix: repairs.join("; "),
  };
}

function commentGate(env: Env, cwd: string, commitGate: Health): Health {
  const name = "comment gate";
  const root = checkoutRoot(cwd);
  let gate: CommentGate;
  try {
    gate = root === null ? { state: "unlabeled" } : commentGateFor(root, "HEAD", env);
  } catch (error) {
    if (error instanceof GitConfigUnreadable) return { name, state: "fail", detail: error.message };
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
      fix: "dim install-commit-gate --owner=<host>/<account> --write",
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

export function diagnose(db: Database, env: Env = process.env, cwd: string = process.cwd()): Health[] {
  const checks: Health[] = [];

  checks.push(
    Bun.which("dim")
      ? { name: "path", state: "ok", detail: `dim resolves to ${Bun.which("dim")}` }
      : {
          name: "path",
          state: "fail",
          detail: "dim is not on PATH, so no agent can reach it from another repo",
          fix: "bun link, from this repo",
        },
  );

  const version = scalar(db, "SELECT version AS n FROM schema_version LIMIT 1");
  checks.push(
    version === SCHEMA_VERSION
      ? { name: "schema", state: "ok", detail: `version ${version}` }
      : {
          name: "schema",
          state: "fail",
          detail: `database is version ${version}, this build expects ${SCHEMA_VERSION}`,
          fix: "dim rebuild",
        },
  );

  const last = text(db, "SELECT max(ingested_at) AS v FROM source_file");
  const age = last ? Date.now() - Date.parse(last) : Number.POSITIVE_INFINITY;
  checks.push(
    !last
      ? { name: "freshness", state: "fail", detail: "nothing has ever been read", fix: "dim sync" }
      : age > 24 * HOUR_MS
        ? {
            name: "freshness",
            state: "warn",
            detail: `last read ${Math.round(age / HOUR_MS)} hours ago`,
            fix: "dim sync",
          }
        : { name: "freshness", state: "ok", detail: `last read ${Math.round(age / HOUR_MS)} hours ago` },
  );

  const hooks = readHooks(env);
  checks.push(sessionHooks(hooks), codexTrust(env));

  const since = text(db, "SELECT min(ts) AS v FROM hook_event");
  const judgeable = since
    ? scalar(
        db,
        `SELECT count(*) AS n FROM session
         WHERE parent_id IS NULL AND started_at >= '${since}'
           AND last_seen_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours')`,
      )
    : 0;
  const ended = since
    ? scalar(
        db,
        `SELECT count(*) AS n FROM session
         WHERE parent_id IS NULL AND started_at >= '${since}' AND end_reason IS NOT NULL
           AND last_seen_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours')`,
      )
    : 0;
  checks.push(endReasons(hooks, since, judgeable, ended));

  const pendingLinks = planSkill(env).filter((p) => p.state !== "linked");
  const retired = retiredLinks(env);
  checks.push(
    pendingLinks.length === 0 && retired.length === 0
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
          fix: "dim install-skill --write",
        },
  );

  const plan = planCommitGate(installedOwners(env) ?? [], [], env);
  const dir = sharedHooksDir(env);
  const gaps = plan.hooks
    .filter((h) => h.state !== "installed")
    .map((h) => `${h.name} is ${h.state}`)
    .concat(
      plan.globalHooksPath === dir
        ? []
        : [`git's global core.hooksPath is ${plan.globalHooksPath ?? "unset"} rather than ${dir}`],
    );
  const commitGate: Health =
    gaps.length === 0
      ? { name: "commit gate", state: "ok", detail: "every hook in place, for every repo" }
      : {
          name: "commit gate",
          state: "warn",
          detail: `${gaps.join(", ")}; those rules are held only where a repo gates its own`,
          fix: "dim install-commit-gate --owner=<owner> --write",
        };
  checks.push(commitGate);

  const owners = installedOwners(env);
  const bareOwners = (owners ?? []).filter((o) => !isHostQualified(o));
  if (owners !== null) {
    checks.push(
      bareOwners.length === 0
        ? {
            name: "gate owners",
            state: "ok",
            detail: `${owners.length} owners, each naming a host and an account`,
          }
        : {
            name: "gate owners",
            state: "fail",
            detail: `${bareOwners.length} owners name an account but no host (${bareOwners.join(", ")}), so the gate arms nowhere`,
            fix: "dim install-commit-gate --owner=<host>/<account> --write",
          },
    );
  }

  checks.push(commentGate(env, cwd, commitGate));

  const unarmed = unarmedCheckouts(
    (db.query("SELECT DISTINCT repo FROM repo_commit ORDER BY repo").all() as { repo: string }[])
      .map((r) => r.repo)
      .filter((repo) => existsSync(join(repo, ".git"))),
  );
  checks.push(
    unarmed.length === 0
      ? { name: "push gate", state: "ok", detail: "every checkout names the branch the gate protects" }
      : {
          name: "push gate",
          state: "warn",
          detail: `${unarmed.length} checkouts have no origin/HEAD, so the push gate exits before reading anything there: ${unarmed
            .map((d) => d.replace(`${resolveHomeDir(env)}/`, ""))
            .join(", ")}`,
          fix: "git remote set-head origin -a, in each",
        },
  );

  const shippedFrom = new Set(
    (
      db
        .query("SELECT DISTINCT repo FROM repo_commit WHERE label IN (SELECT project FROM factory_order)")
        .all() as { repo: string }[]
    )
      .map((r) => primaryCheckout(r.repo))
      .filter((root) => root !== null),
  );
  const unusable = [...shippedFrom].sort().filter((root) => {
    const declared = shipMethod(root);
    return !("method" in declared) || declared.method !== "trunk";
  });
  checks.push(
    unusable.length === 0
      ? {
          name: "ship method",
          state: "ok",
          detail: "every checkout the factory ships from declares dim.ship = trunk",
        }
      : {
          name: "ship method",
          state: "warn",
          detail: `${unusable.length} checkouts the factory ships from declare no dim.ship that \`dim order ship\` can land, so it refuses there: ${unusable
            .map((d) => d.replace(`${resolveHomeDir(env)}/`, ""))
            .join(", ")}`,
          fix: "git config dim.ship trunk, in each",
        },
  );

  const plist = agentPlistPath(env);
  checks.push(
    !existsSync(plist)
      ? {
          name: "agent",
          state: "warn",
          detail: "no launchd agent, so syncing is manual",
          fix: "dim install-agent --write",
        }
      : launchdLoaded()
        ? { name: "agent", state: "ok", detail: "launchd agent loaded" }
        : {
            name: "agent",
            state: "warn",
            detail: "launchd agent is written but not loaded",
            fix: `launchctl bootstrap gui/$(id -u) ${plist}`,
          },
  );

  const rules = planRules(env);
  checks.push(
    rules.state === "missing-source"
      ? { name: "rules", state: "warn", detail: `no ${rules.source} to flatten` }
      : rules.state === "unchanged"
        ? { name: "rules", state: "ok", detail: "codex rules match the canonical file" }
        : {
            name: "rules",
            state: "fail",
            detail:
              rules.state === "absent"
                ? "codex has no rules file, so none of the conventions reach it"
                : "codex rules differ from the canonical file",
            fix: "dim install-rules --write",
          },
  );

  checks.push(retention(env));
  checks.push(spool(env));
  checks.push(harnesses(env));
  const commits = scalar(db, "SELECT count(*) AS n FROM repo_commit");
  checks.push(
    commits === 0
      ? {
          name: "outcomes",
          state: "warn",
          detail: "no commits read, so nothing here can say whether work was right",
          fix: "dim sync, from a machine holding the repos",
        }
      : { name: "outcomes", state: "ok", detail: `${commits} commits read from the repos on disk` },
  );

  return checks;
}
