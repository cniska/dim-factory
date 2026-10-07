# dim-factory

An experiment in automating how I build software. My workflow of scoping, designing, building, reviewing and shipping runs through coding agents, and I stay at the gates that still need me.

dim records sessions on my machine, brings earlier work back to agents, and runs agreed work through checked, isolated stations. Agents use its local CLI to operate the record and the factory; I request work and read the artifacts.

The record is also how the experiment is measured: the artifacts I return, what I catch after review, and the tokens each order uses. [My workflow](docs/my-workflow.md) lists each step and whether the factory does it yet.

- **Record.** Sessions, tool calls, commits and usage in one local SQLite database. No network, no credential, no per-token cost.
- **Recall.** Named queries and keyword search let agents ask what was decided before.
- **Factory.** Orders run through plan, build and review stations as separate Claude Code workers in the order's workspace, with every act recorded and the owner approving each artifact.
- **Gates.** A builder's commit is kept only as one new commit that passes the project's declared check. The project's own hooks and CI stay its gates.
- **Wall.** A read-only board showing where every order is.

[The session database](docs/design.md#sources) lists the agents whose sessions are read, where their files live, and what adding another source takes.

## Agent setup

Clone this repository, open the checkout in Claude Code, and ask the agent to run the project-local [dim-setup skill](.agents/skills/dim-setup/SKILL.md). It installs the CLI and the `dim-factory` skill for use across projects and checks readiness with `dim doctor`.

Then open a project in Claude Code. For routine factory work, ask the agent to use `dim-factory` to add an order and run it by id. The factory gives each station's worker its instructions as the order advances. The [agent command reference](docs/usage.md) explains the commands behind them.

`bun run check` is the repository check.

## Docs

- [Agent command reference](docs/usage.md) — install, collect, query, hooks and config
- [The factory](docs/factory.md) — the argument the factory executes
- [My workflow](docs/my-workflow.md) — the manual workflow the factory replaces
- [Todo](docs/todo.md) — what is not built
- [Everything else](docs/README.md)
