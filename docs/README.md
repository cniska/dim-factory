# Documentation

dim keeps a local record of what every Claude Code and Codex session on this machine did, answers questions against it, and runs work through a factory whose gates hold a rule whether or not a skill loaded. [`README.md`](../README.md) is the tour.

Each fact lives on one page and is linked from the others.

## Why

- [My workflow](my-workflow.md) — how I build with agents by hand, and what the factory replaces
- [Goals](goals.md) — what the factory is for, in order, and how each is measured
- [The landscape](landscape.md) — what else exists, what was borrowed, and what was refused

## How it works

- [The factory](factory.md) — orders, stations, workers, ship and done
- [The wall](wall.md) — the read-only board the owner watches
- [Using dim-factory](usage.md) — install, collect, query, gates and config
- [Session database](design.md) — sources, schema, ingestion, hooks and read path
- [Recall](recall.md) — what reaches a session unasked, and retrieval
- [Worktrees](worktrees.md) — task checkouts and their environments
- [Glossary](glossary.md) — one word per thing
- [Agent anti-patterns](agent-anti-patterns.md) — shapes agents keep writing, and the fix for each
- [Source layout](../src/README.md) — where to start reading the code

## What is true now

- [Todo](todo.md) — what is not built
- [Findings](findings.md) — dated measurements, and what each can carry
