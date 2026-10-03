---
name: dim-verify
description: Drive a changed dim through its own CLI against a throwaway record and read what it did in its trace. Use when a change to dim needs to be seen working, not only tested, or when an order's behavior needs explaining.
---

# Verify

Run the changed checkout's `dim` against a record, a repository and harness configs that exist only for this run, and read what it did in the trace. `bun run verify` proves the suite; this proves the behavior a user meets. The suite does not replace this run, and this run does not replace the suite. The factory's orders are driven by the acceptance suite under `acceptance/`, not by this run.

## Start

From this repository's root:

```sh
scripts/verify-dim.sh new
```

It prints the run's directory; name it in every later call. [`scripts/verify-dim.sh`](../../../scripts/verify-dim.sh) points `HOME` and the three XDG variables into that directory, so the run never reads or writes the machine's record or harness configs. It puts this checkout's `dim` first on `PATH`, installs the session hooks into the scratch configs, and creates a repository at `<run>/repo`.

Readiness: `scripts/verify-dim.sh <run> doctor` reports the schema and `hooks` installed. Its skill and rules checks read the run's home, where nothing else is installed, and do not bear on the run.

## Drive

`scripts/verify-dim.sh <run> <dim args…>` runs one `dim` command in the run's repository. Before the command, the script fires the installed SessionStart spool hook as its own child, so the script is the session's harness.

Each command prints one JSON line; read `ok` and `result`, never the exit code alone. Files the change needs in the repository go in `<run>/repo` and are committed there.

## Trace

`scripts/verify-dim.sh <run> trace <order>` prints every step dim ran for an order: each effect and log append, with its fields, time and outcome. It is the primary evidence of what dim did. Read it after every command that acts on an order, whether the command succeeded or not, and before forming any theory about why an order is where it is.

## Observe

What the trace does not cover, the record and the repository show:

- `scripts/verify-dim.sh <run> sql "<select>"` — any table of the record, read-only.
- `scripts/verify-dim.sh <run> query search "<words>"` — what the record holds of a session's text.
- `git -C <run>/repo log --format='%an | %s' main` — what was committed, and under whose identity.

Name the behavior the change was for, run the commands that reach it, and quote the output that shows it. A result read from the trace or the record beats one inferred from a message.

## Clean up

```sh
rm -rf "$run"
```

## Red flags

- Running `dim` directly rather than through the script, which reads and writes the machine's own record and harness configs
- `skills install`, `agent install` or `rules install` during a run: they write outside the run's directory
- Reporting a run as verified from exit codes, without reading the JSON or the record
- Explaining what an order did from its log, the code or a guess, without reading its trace
- Leaving the run's directory behind
