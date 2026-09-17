import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LABEL, agentPlistPath } from "./agent";
import { codexConfigPath, planCodexTrust } from "./codex-trust";
import { sharedHooksDir } from "./commit-gate";
import { planHooks } from "./hooks";
import { dataDir, type Env, resolveHomeDir } from "./paths";
import { planRules } from "./rules";
import { SCHEMA_VERSION } from "./schema";
import { planSkill } from "./skill";
import { planWt } from "./wt";

/**
 * `warn` is for a gap that costs evidence and `fail` for one that loses it:
 * retention going unset deletes the sources, and hooks that never fire leave a
 * hole no rebuild can fill. Everything a check reports is read from disk, so
 * running this costs nothing and can be wrong about nothing it did not look at.
 */
export type Health = { name: string; state: "ok" | "warn" | "fail"; detail: string; fix?: string };

const HOUR_MS = 3_600_000;

function scalar(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | null)?.n ?? 0;
}

function text(db: Database, sql: string): string | null {
  return (db.prepare(sql).get() as { v: string | null } | null)?.v ?? null;
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
    days = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).cleanupPeriodDays;
  } catch {
    return { name: "retention", state: "warn", detail: `cannot read ${path}` };
  }
  if (typeof days !== "number") {
    return {
      name: "retention",
      state: "fail",
      // The sources are deleted on a timer, and a transcript removed before it
      // was read is gone: this is the only check here that loses history.
      detail: "cleanupPeriodDays is unset, so Claude Code deletes transcripts after 30 days",
      fix: `set "cleanupPeriodDays" in ${path}`,
    };
  }
  return { name: "retention", state: days >= 365 ? "ok" : "warn", detail: `transcripts kept ${days} days` };
}

function spool(env: Env): Health {
  const root = join(dataDir(env), "spool");
  let waiting = 0;
  for (const tool of ["claude", "codex"]) {
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

export function diagnose(db: Database, env: Env = process.env): Health[] {
  const checks: Health[] = [];

  checks.push(
    Bun.which("dim")
      ? { name: "path", state: "ok", detail: `dim resolves to ${Bun.which("dim")}` }
      : {
          name: "path",
          state: "fail",
          // A query an agent cannot run from the repo it is working in is a
          // query that never gets run.
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

  // `ingested_at`, never `origin_mtime`: transcript mtimes get restamped in bulk
  // by things that touch no conversation, so a file's mtime says when something
  // wrote to it and not when anyone last worked.
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

  const missingHooks = planHooks(env).filter((p) => !p.present);
  checks.push(
    missingHooks.length === 0
      ? { name: "hooks", state: "ok", detail: "installed in both tools" }
      : {
          name: "hooks",
          state: "fail",
          detail: `${missingHooks.length} session hooks missing (${missingHooks.map((p) => p.event).join(", ")})`,
          fix: "dim install-hooks --write",
        },
  );

  // Installed is not running: Codex writes a hook into hooks.json the moment
  // install-hooks does, and runs it only once config.toml records a trust for
  // its position. Nothing reports the difference, so collection and `wake` stop
  // on the Codex side with the config still reading as correct.
  const untrusted = planCodexTrust(env).filter((t) => !t.recorded);
  checks.push(
    untrusted.length === 0
      ? { name: "codex trust", state: "ok", detail: "every codex hook has a trust recorded for its position" }
      : {
          name: "codex trust",
          state: "fail",
          detail:
            `${untrusted.length} codex hooks have no trusted_hash under [hooks.state] ` +
            `(${untrusted.map((t) => t.key ?? `${t.event}, not in hooks.json`).join("; ")})`,
          fix: `start a codex session and approve the hook, or remove the stale keys from ${codexConfigPath(env)}`,
        },
  );

  // Installed hooks that produce nothing are the failure this command exists for:
  // the config looks right, and every session still ends indistinguishably. The
  // denominator is sessions that began after the first hook fired — anything
  // earlier could not have been recorded and would make this pass on nothing.
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
  checks.push(
    missingHooks.length > 0
      ? { name: "end reasons", state: "warn", detail: "not expected yet; the hooks are not installed" }
      : !since
        ? {
            name: "end reasons",
            state: "fail",
            detail: "the hooks are installed but have never written an event",
            fix: "check the hook command runs: it must write to the spool and exit 0",
          }
        : judgeable === 0
          ? {
              name: "end reasons",
              state: "ok",
              detail: "no session has both started and finished since the hooks went in",
            }
          : ended / judgeable < 0.5
            ? {
                name: "end reasons",
                state: "fail",
                detail: `only ${ended} of ${judgeable} sessions that ran since the hooks went in recorded an end`,
                fix: "check the hook command runs: it must write to the spool and exit 0",
              }
            : {
                name: "end reasons",
                state: "ok",
                detail: `${ended} of ${judgeable} sessions since the hooks went in recorded an end`,
              },
  );

  // wt establishes the worktree convention this database reads, so a wt that is
  // not this repo's is a convention nothing here verifies.
  const wt = planWt(env);
  checks.push(
    wt.state === "linked"
      ? { name: "wt", state: "ok", detail: "linked to this repo's tested script" }
      : {
          name: "wt",
          state: "warn",
          detail:
            wt.state === "missing"
              ? "wt is not on PATH; worktrees are made by hand or not at all"
              : `${wt.link} is not this repo's script, so nothing tests what runs`,
          fix: "dim install-wt --write",
        },
  );

  const pendingLinks = planSkill(env).filter((p) => p.state !== "linked");
  checks.push(
    pendingLinks.length === 0
      ? { name: "skill", state: "ok", detail: "every skill linked for every tool" }
      : {
          name: "skill",
          state: "warn",
          detail: `${pendingLinks.length} of ${planSkill(env).length} skill links missing`,
          fix: "dim install-skill --write",
        },
  );

  // The gate holds a rule the conventions would otherwise only ask for, so its
  // absence is a rule silently back to being asked rather than held.
  const gate = join(sharedHooksDir(env), "commit-msg");
  checks.push(
    existsSync(gate)
      ? { name: "commit gate", state: "ok", detail: "one hook for every repo" }
      : {
          name: "commit gate",
          state: "warn",
          detail: "no shared commit-msg hook; subjects are held only where a repo gates its own",
          fix: "dim install-commit-gate --owner=<owner> --write",
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
            // Written and never loaded looks identical to working, and nothing
            // syncs until someone runs it by hand.
            detail: "launchd agent is written but not loaded",
            fix: `launchctl bootstrap gui/$(id -u) ${plist}`,
          },
  );

  // Codex expands no imports, so its rules file is a flattened copy and a copy
  // goes stale in silence: the conventions look present in one tool and are
  // absent in the other, which is how a rule gets restated by hand for months.
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
