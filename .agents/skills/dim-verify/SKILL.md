---
name: dim-verify
description: Drive a changed dim through its own CLI against a throwaway record. Use when a change to dim needs to be seen working, not only tested.
---

# Verify

Run the changed checkout's `dim` the way an operator does, against a record, a repository and harness configs that exist only for this run. `bun run verify` proves the suite; this proves the behavior an operator meets. The suite does not replace this run, and this run does not replace the suite.

## Start

From this repository's root:

```sh
eval "$(scripts/verify-home.sh)"
cd "$DIM_VERIFY_REPO"
```

[`scripts/verify-home.sh`](../../../scripts/verify-home.sh) makes a scratch directory and points `DIM_HOME`, `DIM_CLAUDE_PROJECTS`, `DIM_CODEX_DIR` and `GROK_HOME` into it, so the run never reads or writes the machine's record or harness configs. It puts this checkout's `dim` and a scripted `codex` ([`scripts/verify-harness.ts`](../../../scripts/verify-harness.ts)) first on `PATH`, installs the session hooks into the scratch configs, and creates a repository that ships to its own `main`. Everything it owns is under `$DIM_VERIFY_DIR`.

The `eval` also makes the calling shell the operator: it fires the installed SessionStart spool hook from that shell, so the shell is the session's harness, and runs `dim operator`, which registers the session whose harness is above it. Every `dim` command that shell runs, and the workers they start, resolve their identity from that ancestry.

The exports and the operator belong to one shell. A new shell, such as the next tool call, joins the same run with `eval "$(scripts/verify-home.sh "$DIM_VERIFY_DIR")"`, naming the directory the first run printed; it registers that shell as the operator of a new session.

Readiness: `dim doctor` reports the schema, `hooks` installed, and `harnesses` with codex ready. Its skill, commit gate and rules checks read the real home and do not bear on the run.

## Drive

The scripted harness answers each station the way a worker would: the planner returns two slices, the builder writes `built-by-scripted-harness-<n>.txt` and a commit subject per slice with the Build artifact on the last, and the reviewer raises no findings. One order from queue to ship:

```sh
dim order add greet --title "Greet"
dim order plan greet --harness codex
dim order approve greet
dim order build greet --harness codex
dim order approve greet --reason "both slices are present"
dim order review greet --harness codex
dim order approve greet
```

Each command prints one JSON line; read `ok` and `result`, never the exit code alone. For behavior the scripted harness does not produce, such as findings, a red check or a conflict, drive the state the change needs with the commands [`docs/factory.md`](../../../docs/factory.md) lists, or extend the scripted harness in the same change.

## Observe

- `dim q order <id>` — the order's status and next act in its first row, then its history and evidence.
- `dim sql "<select>"` — any table of the record, read-only.
- `git -C "$DIM_VERIFY_REPO" log --format='%an | %s' main` — what landed, and under whose identity.
- `ls "$DIM_VERIFY_REPO/.claude/worktrees"` — worktrees an order kept.

Name the behavior the change was for, run the commands that reach it, and quote the output that shows it. A result read from the record beats one inferred from a message.

## Clean up

```sh
cd / && rm -rf "$DIM_VERIFY_DIR"
```

## Red flags

- Running `dim` without the exports, which writes the machine's own record and harness configs
- Driving an order from a shell that did not `eval` the script: it has no operator above it
- `install-commit-gate`, `install-skill`, `install-agent` or `install-rules` during a run: they write outside the scratch directory
- Reporting a run as verified from exit codes, without reading the JSON or the record
- Leaving `$DIM_VERIFY_DIR` behind
