# Using dim-factory

## Install

```sh
mise install
bun install
bun link       # puts dim on PATH
```

## Collect and inspect

```sh
dim sync       # read new Claude Code and Codex session data
dim stats      # stored row and usage counts
dim doctor     # check the installation and name repairs
dim rebuild    # rebuild tables from their sources
dim q list     # the named queries
dim q <name>
dim sql "<read-only select>"
```

`dim` with no command lists every command with its usage. [Session database](design.md) covers sources, schema and output.

## Install the shared controls

```sh
dim install-hooks
dim install-rules
dim install-skill
dim install-commit-gate --owner=<host>/<account>
```

- A command that changes a shared installation needs `--write`.
- Each hook command ends in `# dim-hook:<version>`, bumped whenever its text changes; an older version is stale.
- `dim doctor` reports missing or stale hooks, missing Codex trust, database drift, unloaded agents, a checkout with no usable ship method, a harness installed but not routed or routed but not installed, and whether the comment gate is on — each with its repair.

### Commit gate

Runs the repository's declared check before a commit. `DIM_SKIP_CHECK=1` skips it for one commit.

### Comment gate

Part of the commit gate, on where the [config](#configuration) resolves `comments` to `banned`. The project layer is read as `HEAD` commits it, so one commit cannot both lift the ban and add a comment.

- `dim comments check` parses each staged JS or TS file with `@babel/parser` and prints `path:line` for every comment on an added or edited line, exiting 3 when it finds one.
- Only added lines count, so a repo with existing comments can turn the ban on without a sweep. In a merge a line counts only where it is added against every parent.
- A file rewritten past git's rename detection is a new file.
- **Not judged:** tool contracts (`/// <reference …>`, `@ts-`, `eslint-`, `biome-ignore`, `prettier-ignore`, `#__PURE__`, `@__PURE__`, a `/*!` license header, and in plain JS a JSDoc of only `@type`, `@typedef` or `@param`), a `#!` line, files git marks `linguist-generated` or `linguist-vendored`, files that do not parse (named on stderr), and other languages.
- A config that cannot be read lets the commit through and says why.
- A factory builder's commit is judged by the runner instead, by the same rules ([`factory.md`](factory.md)).

`dim comments purge [<path>...]` reports the comments tracked JS and TS files hold. `--write` removes them, sets `comments` to `banned` in the project config and runs the declared format command; then run the check and commit. Languages are adapters in [`src/comments-language.ts`](../src/comments-language.ts).

### Push gate

Refuses a rewrite or deletion of the remote default branch, and any push carrying a revert, since git commits a revert without running the commit gate. A repository's own `core.hooksPath` is left alone.

### Ship method

A repository the factory ships from declares it with `git config dim.ship trunk`; [`factory.md`](factory.md#done) says what `dim order ship` does with it.

## Configuration

Two layers of JSON: the user's `~/.config/dim/config.json` and the project's committed `.dim/config.json`, which overrides it setting by setting. [`src/config.ts`](../src/config.ts) holds the settings and their values; an unknown one is refused.

```sh
dim config
dim config set comments banned --project
dim config unset comments
```

| Setting | Values |
|---|---|
| `comments` | `banned` turns on the comment gate; `allowed` turns it off |

## Worktrees and stations

```sh
dim wt <branch>
dim wt ls
dim wt path <branch>
```

See [Worktrees](worktrees.md). The line's entry points are the `dim-line-feat` and `dim-line-fix` skills, its stations `dim-station-plan`, `dim-station-build` and `dim-station-review`, and `dim-factory` operates it ([`factory.md`](factory.md)).

## Session start

`dim wake` prints the last handoff's `## Next` and the repo's declared check and format commands; the `SessionStart` hook runs it ([Recall](recall.md)).

## Verification

`bun run verify` runs lint, typecheck, tests and the worktree checks. `bun run format` formats.
