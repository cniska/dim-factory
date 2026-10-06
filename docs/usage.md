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
dim skills install
```

- Each install writes at once and copies aside any file it replaces.
- Each hook command ends in `# dim-hook:<version>`, bumped whenever its text changes; an older version is stale.
- Hooks and the skill link are for Claude Code, and are installed and checked only while `claude` is on `PATH`. The `dim-factory` skill links into `~/.claude/skills`. Other harnesses' sessions are read into the record without any hook.
- `dim doctor` reports missing, stale or retired hooks, database drift and unloaded agents, each with its repair.

## Install the canonical gates

```sh
dim gates install   # from the project's checkout
```

- Writes each canonical gate from [`gates/`](../gates) into the checkout, where the project commits it: the commit-subject hook in `.githooks/`, the `commits.yml` workflow that runs it on every pushed commit, and a pre-commit hook that runs the project's declared check. A project that declares no check is refused.
- Points `core.hooksPath` at `.githooks`, and adds the same command as a `package.json` `prepare` script so a fresh clone runs the gates. A checkout whose hooks run from elsewhere, or whose `prepare` does something else, is refused before anything is written.
- Each gate carries `dim-gate:<version>`. A gate at a lower version is replaced; one at the same version with other bytes was changed in place and is moved aside before it is replaced; one at a higher version is left. A project extends a gate with a file of its own beside it.
- `dim doctor`, run in a checkout, reports each gate that is missing, behind or changed, and hooks that do not run from `.githooks`.

### Comment purge

`dim comments purge [<path>...]` reports the comments tracked JS and TS files hold, parsed with `@babel/parser`. `--write` removes them and runs the declared format command; then run the check and commit. A test that runs the same scan and expects nothing keeps the code free of them, as dim-factory's `src/no-comments.test.ts` does.

- **Left in place:** tool contracts (`/// <reference …>`, `@ts-`, `eslint-`, `biome-ignore`, `prettier-ignore`, `#__PURE__`, `@__PURE__`, a `/*!` license header, and in plain JS a JSDoc of only `@type`, `@typedef` or `@param`), a `#!` line, files git marks `linguist-generated` or `linguist-vendored`, files that do not parse (named in the report), and other languages.
- Languages are adapters in [`src/comments-language.ts`](../src/comments-language.ts).

## Configuration

Two layers of JSON: the user's `config.json` in the [config directory](core.md#paths) and the project's committed `.dim/config.json`, which overrides it setting by setting. [`src/config.ts`](../src/config.ts) holds the settings and their values; an unknown one is refused.

```sh
dim config
dim config set ship default-branch --project
dim config unset ship
```

| Setting | Values |
|---|---|
| `ship` | `default-branch` lands an approved order on the project's default branch by fast-forward |
| `models` | User config only, edited in `config.json`: a model name for any of `planner`, `builder` and `reviewer`, and a `default` for the rest. A station refuses to start a role with no model |

## Session start

The `SessionStart` hook runs `dim hooks start` to print the repo's declared check and format commands.

## Verification

`bun run verify` runs lint, typecheck and tests. `bun run format` formats.
