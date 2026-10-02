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
```

- Each install writes at once and copies aside any file it replaces.
- Each hook command ends in `# dim-hook:<version>`, bumped whenever its text changes; an older version is stale.
- Hooks, Codex rules, Codex hook trust and `~/.codex/skills` are installed and checked only for a harness whose executable is on `PATH`; `~/.agents/skills` is linked whatever is installed.
- `dim doctor` reports missing or stale hooks, missing Codex trust, database drift and unloaded agents, each with its repair.

A project's gates are its own: its hooks, its tests and its CI, which the factory runs as any contributor does.

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

## Session start

The `SessionStart` hook runs `dim hooks start` to print the repo's declared check and format commands.

## Verification

`bun run verify` runs lint, typecheck and tests. `bun run format` formats.
