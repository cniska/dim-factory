---
name: dim-verify
description: Drive a changed dim through its own CLI against a throwaway record. Use when a change to dim needs to be seen working, not only tested.
---

# Verify

Run the changed checkout's `dim` the way an operator does, against a record, a repository and harness configs that exist only for this run. `bun run verify` proves the suite; this proves the behavior an operator meets. The suite does not replace this run, and this run does not replace the suite.

## Start

From this repository's root:

```sh
scripts/verify-dim.sh new
```

It prints the run's directory; name it in every later call. [`scripts/verify-dim.sh`](../../../scripts/verify-dim.sh) points `DIM_HOME`, `DIM_CLAUDE_PROJECTS`, `DIM_CODEX_DIR` and `GROK_HOME` into that directory, so the run never reads or writes the machine's record or harness configs. It puts this checkout's `dim` and a scripted `codex` ([`scripts/verify-harness.ts`](../../../scripts/verify-harness.ts)) first on `PATH`, installs the session hooks into the scratch configs, and creates a repository at `<run>/repo` that ships to its own `main`.

Readiness: `scripts/verify-dim.sh <run> doctor` reports the schema, `hooks` installed, and `harnesses` with codex ready. Its skill, commit gate and rules checks read the real home and do not bear on the run.

## Drive

`scripts/verify-dim.sh <run> <dim args…>` runs one `dim` command in the run's repository as its operator. Before the command, the script fires the installed SessionStart spool hook as its own child, so the script is the session's harness, and runs `dim operator`, which registers that session. The command and the workers it starts resolve their identity from that ancestry. Each call is its own session, so each approval names a different operator.

The scripted harness answers each station the way a worker would: the planner returns two slices, the builder writes `built-by-scripted-harness-<n>.txt` and a commit subject per slice with the Build artifact on the last, and the reviewer raises no findings. One order from queue to ship:

```sh
scripts/verify-dim.sh "$run" order add greet --title "Greet"
scripts/verify-dim.sh "$run" order plan greet --harness codex
scripts/verify-dim.sh "$run" order approve greet
scripts/verify-dim.sh "$run" order build greet --harness codex
scripts/verify-dim.sh "$run" order approve greet --reason "both slices are present"
scripts/verify-dim.sh "$run" order review greet --harness codex
scripts/verify-dim.sh "$run" order approve greet
```

Each command prints one JSON line; read `ok` and `result`, never the exit code alone. For behavior the scripted harness does not produce, such as findings, a red check or a conflict, drive the state the change needs with the commands [`docs/factory.md`](../../../docs/factory.md) lists, or extend the scripted harness in the same change. Files the change needs in the repository go in `<run>/repo` and are committed there.

## Observe

- `scripts/verify-dim.sh <run> q order <id>` — the order's status and next act in its first row, then its history and evidence.
- `scripts/verify-dim.sh <run> sql "<select>"` — any table of the record, read-only.
- `git -C <run>/repo log --format='%an | %s' main` — what landed, and under whose identity.
- `ls <run>/repo/.claude/worktrees` — worktrees an order kept.

Name the behavior the change was for, run the commands that reach it, and quote the output that shows it. A result read from the record beats one inferred from a message.

## Clean up

```sh
rm -rf "$run"
```

## Red flags

- Running `dim` directly rather than through the script, which reads and writes the machine's own record and harness configs
- `install-commit-gate`, `install-skill`, `install-agent` or `install-rules` during a run: they write outside the run's directory
- Reporting a run as verified from exit codes, without reading the JSON or the record
- Leaving the run's directory behind
