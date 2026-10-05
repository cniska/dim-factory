---
name: dim-setup
description: Set up a fresh dim-factory clone for coding agents. Use after cloning or when the local installation is incomplete.
---

# Setup

Set up dim on this machine so coding agents can operate the factory from other projects through its `dim-factory` skill. This skill lives in the clone and runs before that skill is installed. [The agent command reference](../../../docs/usage.md) owns the command details. Doctor's observed state determines each repair; an installer exit alone does not establish readiness.

## Entry contract

Run from this repository's root. Confirm it has `package.json`, `bun.lock`, `mise.toml` and `src/cli.ts`. Read the existing installation before changing it. A rerun changes only what is missing or stale; it does not duplicate hooks, links or the sync agent.

## Bootstrap

Run `mise install` and `bun install` to bring the declared toolchain and dependencies into this clone. Resolve the executable behind `dim` on PATH, not just its link name. Run `bun link` if it does not lead to this checkout's `src/cli.ts`, then resolve it again. A different executable still winning PATH is a blocker; use `bun src/cli.ts` for diagnostics and do not install hooks under the wrong executable. Keep the committed lockfile unchanged.

Run `dim sync` to populate the local record. If it refuses a schema mismatch, run `dim rebuild`, then repeat the sync. Run `dim doctor` and read each check's state and repair, not just the command's exit.

## Repair from doctor

Use the doctor's findings to choose only the needed installers. Each writes when run, so read the paths and scope doctor names before running it:

- `dim hooks install` for Claude Code's session hooks.
- `dim skills install` for the `dim-factory` skill in Claude Code's skill directory.
- `dim agent install` on macOS when scheduled sync is wanted. Run it even when doctor says the agent is loaded, because the plist names this checkout and the installed Bun path. Its result gives the command to load the launchd agent.

On Linux, run `dim sync` manually; the launchd installer is macOS-specific.

Run an installer when setup was requested and its scope is understood. An occupied skill link is moved aside to the backup the result names; check that it pointed to a previous dim checkout, and take an unrelated occupied path or owner-specific choice to the owner. Keep configuration outside dim's planned change intact. If a loaded launchd job's plist changed, use the installer's returned remove command before its load command, then inspect the loaded job; writing the plist alone does not restart it.

Run `dim doctor` again after repairs. Retention choices may need the owner; name those checks and the action they need. A warning is a stated limitation, not a passing check.

## Exit check

Setup is ready when the executable, hooks and skill checks are healthy, the user's `config.json` names a model for every station role or a `default` ([configuration](../../../docs/usage.md#configuration)), and `dim-factory` resolves from Claude Code's skill directory. Check the executable and skill targets from a separate project checkout; both must still lead to this clone. `dim-factory` adds an order from a new request and operates an existing order id. Report observational doctor failures such as insufficient session-end history separately, with the evidence needed to judge them after more sessions. If an external or owner-dependent action remains, report setup as blocked with its concrete next step. On a second run with the same inputs, the installers make no changes.

## Result

Report which controls were installed or already healthy, the final doctor result, and each unresolved check with its repair or decision. Do not claim setup is complete from a successful installer alone.

## Red flags

- calling a different `dim` from PATH
- writing machine-wide hooks before reading what doctor says they change
- treating a doctor's warning or failure as a successful installation
- concealing a trust or retention decision the owner must make
