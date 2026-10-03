# dim-factory

A software factory run by coding agents, with a human at the gates that still earn one.

dim records sessions on this machine, brings earlier work back to agents, and runs agreed work through checked, isolated stations. Agents use its local CLI to operate the record and the factory; the owner requests work and reads the artifacts.

- **Record.** Sessions, tool calls, commits and usage in one local SQLite database. No network, no credential, no per-token cost.
- **Recall.** Named queries and keyword search let agents ask what was decided before.
- **Gates.** Hooks that hold mechanical rules — commit subjects, the repo's check, comments, pushes to the default branch — whether or not a skill loaded.
- **Factory.** Orders run through plan, build and review stations as separate workers in the order's workspace, with every act recorded and the owner approving each artifact.
- **Wall.** A read-only board showing where every order is.

[The session database](docs/design.md#sources) lists the agents whose sessions are read, where their files live, and what adding another source takes.

## Agent setup

Clone this repository, open the checkout in Claude Code or Codex, and ask the agent to run the project-local [dim-setup skill](.agents/skills/dim-setup/SKILL.md). It installs the CLI and shared skills for use across projects and checks readiness with `dim doctor`.

Then open a project in your harness. For routine factory work, ask the agent to use `dim-add` to create an order and `dim-factory` to run it by id. The agents invoke the station skills as the order advances. The [agent command reference](docs/usage.md) explains the commands behind those skills.

`bun run verify` is the repository check.

## Docs

- [Agent command reference](docs/usage.md) — install, collect, query, gates and config
- [The factory](docs/factory.md) — the argument the factory executes
- [My workflow](docs/my-workflow.md) — the manual workflow the factory replaces
- [Todo](docs/todo.md) — what is not built
- [Everything else](docs/README.md)
