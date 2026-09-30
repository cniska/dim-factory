# Agent command reference

These commands are for coding agents setting up dim, inspecting its local record and operating its controls. [The factory](factory.md) describes orders and artifact decisions.

## Install

```sh
mise install
bun install
bun link       # puts dim on PATH
```

## Collect and inspect

```sh
dim sync       # read new session data
dim doctor     # check the installation and name repairs
dim rebuild    # rebuild tables from their sources
dim query list     # the named queries
dim query <name>
dim sql "<read-only select>"
```

`dim` with no command lists every command with its usage. [Session database](design.md) covers sources, schema and output.

## Install the shared controls

```sh
dim hooks install
dim rules install
dim skills install
dim gate install --owner <host>/<account>
```

- Each install writes at once and copies aside any file it replaces.
- Each hook command ends in `# dim-hook:<version>`, bumped whenever its text changes; an older version is stale.
- Hooks, Codex rules, Codex hook trust and `~/.codex/skills` are installed and checked only for a harness whose executable is on `PATH`; `~/.agents/skills` is linked whatever is installed.
- `dim doctor` reports missing or stale hooks, missing Codex trust, database drift, unloaded agents, and whether the comment gate is on — each with its repair.

### Commit gate

Each git hook the gate installs calls `dim gate`, and each hook's rules are one entry in [`src/gate-registry.ts`](../src/gate-registry.ts). A hook that cannot find or run `dim` lets the commit or push through and says it was not judged.

- A commit's subject is a Conventional Commit of at most 50 ASCII characters, with no body. A `fixup!` subject is judged by the subject it names, so `git commit --fixup` makes a commit that `git rebase --autosquash` folds in; `dim gate check` still refuses one that is left in a range.
- The repository's declared check runs before the commit. `DIM_SKIP_CHECK=1` skips it and the comment gate for one commit.

### Comment gate

Part of the commit gate, on where the [config](#configuration) resolves `comments` to `banned`. The project layer is read as `HEAD` commits it, so one commit cannot both lift the ban and add a comment.

- Each staged JS or TS file is parsed with `@babel/parser`, and the refusal names `path:line` for every comment on an added or edited line.
- Only added lines count, so a repo with existing comments can turn the ban on without a sweep. In a merge a line counts only where it is added against every parent.
- A file rewritten past git's rename detection is a new file.
- **Not judged:** tool contracts (`/// <reference …>`, `@ts-`, `eslint-`, `biome-ignore`, `prettier-ignore`, `#__PURE__`, `@__PURE__`, a `/*!` license header, and in plain JS a JSDoc of only `@type`, `@typedef` or `@param`), a `#!` line, files git marks `linguist-generated` or `linguist-vendored`, files that do not parse (named on stderr), and other languages.
- A config it cannot read lets the commit through, says why, and still runs the check.

`dim comments purge [<path>...]` reports the comments tracked JS and TS files hold. `--write` removes them, sets `comments` to `banned` in the project config and runs the declared format command; then run the check and commit. Languages are adapters in [`src/comments-language.ts`](../src/comments-language.ts).

### Push gate

Refuses a rewrite or deletion of the remote default branch, and any push carrying a revert, since git commits a revert without running the commit gate. A repository's own `core.hooksPath` is left alone.

## Configuration

Two layers of JSON: the user's `config.json` in the [config directory](core.md#paths) and the project's committed `.dim/config.json`, which overrides it setting by setting. [`src/config.ts`](../src/config.ts) holds the settings and their values; an unknown one is refused.

```sh
dim config
dim config set comments banned --project
dim config unset comments
```

| Setting | Values |
|---|---|
| `comments` | `banned` turns on the comment gate; `allowed` turns it off |

## Session start

The `SessionStart` hook runs `dim hooks start` to print the repo's declared check and format commands and record which guidance files were in force.

## Verification

`bun run verify` runs lint, typecheck and tests. `bun run format` formats.
