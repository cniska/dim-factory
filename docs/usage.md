# Using dim-factory

This page covers the commands that install dim-factory, collect session records, query them and run work through its stations.

## Install

The repository uses the toolchain pinned by `mise.toml`.

```sh
mise install
bun install
```

`bun link` puts `dim` on `PATH`, so another checkout can use the same installation.

## Collect and inspect

The database lives at `~/.local/share/dim-factory/sessions.db`.

```sh
dim sync       # read new Claude Code and Codex session data
dim stats      # show stored row and usage counts
dim doctor     # check installation and name repairs
dim rebuild    # rebuild derived tables from their sources
```

Named questions are listed and run with:

```sh
dim q list
dim q <name>
dim q <name> --json
dim sql "<read-only select>"
```

Queries state the evidence base and report when no evidence is available. See [Session database](design.md) for sources, schema and read-path rules.

## Install the shared controls

```sh
dim install-hooks
dim install-rules
dim install-skill
dim install-commit-gate --owner=<host>/<account>
```

Commands that change a shared installation require `--write`. `dim doctor` reports missing or stale hooks, missing trust, database drift, unloaded agents and a station harness that is installed but not routed, or routed but not installed, together with the repair for each failure.

The commit gate checks the repository's declared task before a commit. The push gate protects the remote default branch from rewrites and deletion, and refuses any push carrying a revert — git commits a revert without running the commit gate, so the push is where one is caught. A repository's own `core.hooksPath` or an existing managed global hooks path is left alone. The gate rules and ownership model are described in [The factory](factory.md).

## Worktrees and stations

Create an isolated task checkout with:

```sh
dim wt <branch>
dim wt ls
dim wt path <branch>
```

The worktree command creates `.claude/worktrees/<branch>` and runs the repository setup hook when one exists. See [Worktrees](worktrees.md) for lifecycle and write recovery.

The line has two entry points:

- **`dim-line-feat`** — start feature work, scope it against the record and cut it into verified slices.
- **`dim-line-fix`** — start defect work, triage it and prove it with a failing test before fixing it.

The stations are:

- **`dim-station-plan`** — scope work against prior art and decisions when the cut is not clear.
- **`dim-station-build`** — run the check, simplify the slice, obtain a read-only check, answer findings and commit.
- **`dim-station-review`** — review a completed diff dimension by dimension without editing it.

`dim-factory` is the operator above the line: it reads a queue, chooses an unblocked item and routes it to the right entry point.

See [The factory](factory.md) for order ownership, reports, queue planning and the human gates.

## Session start

`dim wake` prints the last handoff's `## Next` together with the repository's declared check and format commands. The installed `SessionStart` hook can provide that context automatically. [Reaching a session without being asked](recall.md) describes the handoff chain and the token budget for startup context.

## Verification

The repository check is:

```sh
bun run verify
```

It runs linting, typechecking, tests and worktree checks. `bun run format` formats source files.
