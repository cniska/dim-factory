# Documentation

dim keeps a local record of what every coding-agent session on this machine did, answers questions against it, and runs work through a factory whose gates hold a rule whether or not a skill loaded. [`README.md`](../README.md) is the tour. The sessions it reads are listed in [the session database](design.md#sources).

Each fact lives on one page and is linked from the others.

## Why

- [My workflow](my-workflow.md) — how I build with agents by hand, and what the factory replaces
- [Goals](goals.md) — what the factory is for, in order
- [The factory](factory.md) — the argument the factory executes
- [The landscape](landscape.md) — what else exists, what was borrowed, and what was refused

## How it works

- [The factory core](core.md) — how an order runs from added to shipped
- [The wall](wall.md) — the read-only board the owner watches
- [Adopting a project](adopting.md) — what a project needs before the factory runs its orders
- [Agent command reference](usage.md) — install, collect, query, hooks and config
- [Evals](evals.md) — measuring what a station's instructions change
- [Session database](design.md) — sources, schema, ingestion, hooks and read path
- [Glossary](glossary.md) — one word per thing
- [Source layout](../src/README.md) — where to start reading the code

## What is true now

- [Specification](../SPEC.md) — what holds
- [Todo](todo.md) — what is not built
