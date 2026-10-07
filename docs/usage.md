# Agent command reference

These commands are for coding agents setting up dim, inspecting its local record and operating its controls. [The factory](factory.md) describes orders and artifact decisions.

## Install

```sh
mise install
bun install
bun link       # puts dim on PATH
```

`dim` runs under the bun this checkout pins, through mise, whichever bun the calling project pins ([`bin/dim`](../bin/dim)).

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
- `dim doctor` reports missing, stale or retired hooks, database drift and unloaded agents, each with its repair, and whether a worker can sign in. In a project's checkout it also reports each [adoption need](adopting.md#what-the-project-needs) and the project's gates.

## Install the canonical gates

```sh
dim gates install [<gate>...]   # from the project's checkout
```

- The gates, whose files are in [`gates/`](../gates):
  - `commit-subject`: a `commit-msg` hook, and a `commits.yml` workflow that runs it on every pushed commit.
  - `check`: a pre-commit step that runs the project's [check](glossary.md), and a `check.yml` workflow that runs it on every push on `ubuntu-latest`, after `mise`'s pinned tools when the project has a `mise.toml` and a frozen install when it has a lockfile.
  - `no-comments`: a pre-commit step and a `no-comments.yml` workflow that run the comment scanner under `node`. The scanner is a core plus one parser per [ecosystem](glossary.md), and a project gets only the parsers for the ecosystems it uses. Both are bundled from the code `dim comments purge` runs; `bun run gates:bundle` rebuilds them, and a test fails while they are stale. A project in no ecosystem the scanner reads is refused `no_ecosystem`.
- `.githooks/pre-commit` runs each executable in `.githooks/pre-commit.d/` in name order and stops at the first that fails. It is installed while a chosen gate has a step there, and a project adds a step of its own the same way.
- Naming gates records them as the project's choice, `gates` in `.dim/config.json`, and installs exactly those, removing an installed gate no longer chosen. With none named it installs the recorded choice; with no choice recorded, a terminal shows a picker and anything else is refused `no_gates_chosen`. Choosing `check` in a project that declares no check is refused `no_check`. Each refusal writes nothing.
- After it changes the project's settings or `package.json`, it runs the project's format task, so the project's formatter has the last word on how those files look. Naming the gates already chosen changes nothing. The installed scanner tells Biome and ESLint to leave it alone; a project whose linter honors neither excludes `.githooks/no-comments` itself.
- Points `core.hooksPath` at `.githooks`, and adds the same command as a `package.json` `prepare` script so a fresh clone runs the gates. A checkout whose hooks run from elsewhere, or whose `prepare` does something else, is refused before anything is written.
- Each gate carries `dim-gate:<version>`. A gate at a lower version is replaced; one at the same version with other bytes was changed in place and is moved aside before it is replaced; one at a higher version is left. A project extends a gate with a file of its own beside it.
- `dim doctor`, run in a checkout, reports no choice recorded, each chosen gate that is missing, behind or changed, a gate installed but not chosen, and hooks that do not run from `.githooks`.

### Comment purge

`dim comments purge [<path>...]` reports the comments tracked JS and TS files hold, parsed with `@babel/parser`. `--write` removes them and runs the declared format command; then run the check and commit. Run it before choosing the `no-comments` gate, which fails on any comment the purge would remove.

- **Left in place:** tool contracts (`/// <reference …>`, `@ts-`, `eslint-`, `biome-ignore`, `prettier-ignore`, `#__PURE__`, `@__PURE__`, a `/*!` license header, and in plain JS a JSDoc of only `@type`, `@typedef` or `@param`), a `#!` line, files git marks `linguist-generated` or `linguist-vendored`, files that do not parse (named in the report), and other languages.
- Languages are adapters listed in [`src/comments-languages.ts`](../src/comments-languages.ts).

## Configuration

Two layers of JSON: the user's `config.json` in the [config directory](core.md#paths) and the project's committed `.dim/config.json`, which overrides it setting by setting. [`src/config-contract.ts`](../src/config-contract.ts) holds each setting's layers and values; an unknown setting, or one set in the wrong layer, is refused. A key inside a section is set by its dotted name, and unsetting a section's last key removes the section.

```sh
dim config
dim config set ship default-branch --project
dim config set tasks.check verify --project
dim config set models.default claude-opus-5-5
dim config unset ship
```

| Setting | Layer | Values |
|---|---|---|
| `ship` | user, project | `default-branch` lands an approved order on the project's default branch by fast-forward |
| `tasks.check` | project | The declared task that is the project's [check](glossary.md); without it, the task named `check` |
| `tasks.format` | project | The declared task that formats; without it, the task named `format` |
| `models.<role>` | user | A model name for `planner`, `builder` or `reviewer`, and `models.default` for the rest. A station refuses to start a role with no model |
| `gates` | project | The [canonical gates](#install-the-canonical-gates) the project chose, set by `dim gates install` |

## Session start

The `SessionStart` hook runs `dim hooks start` to print the repo's declared check and format commands.

## Verification

`bun run check` runs lint, typecheck and tests. `bun run format` formats.
