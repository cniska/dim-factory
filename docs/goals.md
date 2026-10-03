# Goals

What the factory is for, in order. Each goal is about the owner's time; the second and third serve the first.

## 1. Building takes less of the owner's time

A change succeeds when shipping the same thing costs fewer of the owner's minutes: less re-explaining, fewer decisions handed back, less re-deriving what the record already holds.

- **What moves it** is delivery and mechanism, not stronger wording: put a rule where it reaches the work, make a rule a hook when the event payload decides it, and get a known fact to the moment it is needed. A hook warns rather than blocks wherever a correct agent could trip it.

## 2. Stay clear of usage limits

A limit reached stops the build and costs the wait, so fitting more work inside the budget is a time goal too. It never overrides the first.

- **Context is re-read on every call.** A character in a skill body or rules file is paid on every call after it loads. The heaviest cost is a skill loaded often and left resident, not the longest file.
- **Tool output is the larger half.** Tool results, file contents and conversation outweigh instruction bodies.

## 3. Work that held up becomes precedent

A good example teaches more cheaply than a rule. The label comes from the owner or a review, never from the absence of a later fix.

## Cutting guidance

How a line leaves a skill or a rules file:

1. **Find candidates** in the record — `dim query search` for rules restated by hand, `skill_load` for bodies that cost the most across their loads.
2. **Decide by reading.** The record never decides: a skill's versions are each loaded in a handful of sessions, and the text changes with the task.
3. **Record the cost** — characters removed times loads in the window.
4. **Check it held** — `skill_load.body_sha256` shows the new body arriving. It says nothing about whether sessions improved.

A rule leaves `~/.claude/CLAUDE.md` only once a gate holds it, since moving it into a skill cuts its reach to the sessions that load that skill.

## Direction

- **The factory runs an order; the project keeps its rules.** The factory makes the workspace, installs its dependencies, runs the check and ships, the steps every project needs. A project's gates — its hooks, tests and CI — stay in the project, and the factory runs them as any contributor does.
- **The core is general; a project's differences are settings.** The session record, orders, workspaces, attributed approvals, the wall and trust earned per kind of order hold for any repo. How a project ships is a setting, added when the first project that needs it is adopted.
- **Local, and the record under any harness.** No vendor builds a ledger that compares its own agent against another's, so the record stays on the machine and reads every harness's sessions. Station workers run under Claude Code.
