# Documentation

dim keeps a local record of what every Claude Code and Codex session on this machine did, answers questions against it, and installs gates that hold a rule whether or not a skill loaded. [`README.md`](../README.md) is the tour; these pages are the reasoning behind it.

Each page owns its subject. A fact lives on one of them and is linked to from the others, because two authorities drift and the one nobody updates wins.

## Why it exists

- [The factory](factory.md) — the argument this repo executes, as a position to argue with
- [Goals](goals.md) — what it is for, in order, and how each goal is known to be met
- [The landscape](landscape.md) — what else exists, what is worth borrowing, and what was refused

## What is true now

- [Findings](findings.md) — what the corpus said when asked, dated, with what each number can carry
- [Build order](build-order.md) — what is unbuilt, and what each piece waits on

## How it is built

- [Using dim-factory](usage.md) — installation, collection, queries, hooks, worktrees and stations
- [Session database](design.md) — the schema, the sources it re-reads, and the rules each table follows
- [Reaching a session without being asked](recall.md) — the channel that arrives, and the benchmark that scores what is pulled
- [Worktrees](worktrees.md) — parallel checkouts, and undoing what an agent wrote

## Designs not yet built

- [The loop](loop.md) — how a line gets cut from a skill and stays cut
- [Generating the conventions](conventions.md) — a generated block naming the rules a gate holds
- [An instrument that can justify a cut](evals-and-hooks.md) — the eval arms and the hooks layout
