# Adopting a project

A project is adopted when the factory can run an order in it from added to shipped. Adoption writes into the project only its settings file and the canonical gates it chooses, which the project commits and owns ([usage](usage.md#install-the-canonical-gates)). The machine is set up once, through [`dim-setup`](../.agents/skills/dim-setup/SKILL.md).

## What the project needs

Each line names the refusal an order meets without it. `dim doctor`, run in the project's checkout, reports each one that does not hold.

| Need | Refusal |
|---|---|
| A git checkout whose `origin` remote names an `owner/repo` project | `no_project` |
| `origin/HEAD` set, which names the default branch: `git remote set-head origin --auto` | `no_default_branch` |
| A git `user.name` and `user.email`, which every factory commit carries | `no_git_identity` |
| A declared check: the `package.json` script, `mise.toml` task or `Makefile` target named `check`, or the one `dim config set tasks.check <task> --project` names ([`src/declared-tasks.ts`](../src/declared-tasks.ts)) | `no_check` |
| A lockfile that installs frozen with install scripts off, such as `bun install --frozen-lockfile --ignore-scripts` | `install_failed` |
| Every tool `mise.toml` pins, installed | `toolchain_unresolved` |
| `.dim/config.json` on the default branch saying how the project ships: `dim config set ship default-branch --project`, then commit it | `ship_unset` |
| `CLAUDE_CODE_OAUTH_TOKEN` in the environment `dim` runs from, made by `claude setup-token`, since a worker runs with its own home and never sees the owner's login | `no_sign_in` |

The dependency install and the check run in a sandbox that writes only inside the order's tree and its own temporary directory ([`src/check.ts`](../src/check.ts)), so a check that writes elsewhere fails there though it passes in the checkout. Both get a listed environment with no credentials and `HOME` set to that temporary directory, so a check that reads the owner's home or a secret fails too. The network stays open to both.

A ship fast-forwards the default branch of the checkout, so a project that lands every change through a pull request can take only work it would commit straight to that branch until shipping through a pull request is built ([todo](todo.md)).

## The operator

The operator is a Claude Code session in the project's checkout, with dim's hooks installed. Its first operator act registers it as the project's operator, and orders are added from there through the `dim-factory` skill. The factory reads the project's settings from a checkout a session on record ran in, so an order added from anywhere else is refused `no_checkout`.
