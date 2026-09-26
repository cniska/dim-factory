# Goals

What the factory is for, in order. Each goal is about the owner's time; the second and third serve the first.

## 1. Building takes less of the owner's time

A change succeeds when shipping the same thing costs fewer of the owner's minutes: less re-explaining, fewer decisions handed back, less re-deriving what the record already holds.

- **Measured by** `q repeats` — a phrase typed across several sessions is a point that did not land — and by `q rework` and `q fixes`.
- **A stop is not a correction.** Most interrupts carry no text and may be a redirect or new context. `q corrections` splits `rejected`, `interrupted` and `with_feedback`, and only the feedback carries a reason.
- **Blind spot.** These count friction someone noticed. Wrong work that was accepted looks like right work.
- **What moves it** is delivery and mechanism, not stronger wording: put a rule where it reaches the work, make a rule a hook when the event payload decides it, and get a known fact to the moment it is needed. A hook warns rather than blocks wherever a correct agent could trip it.

## 2. Stay clear of usage limits

A limit reached stops the build and costs the wait, so fitting more work inside the budget is a time goal too. It never overrides the first.

- **Measured by** `q burn`: spend against edits per rolling five-hour block. Nothing records a rate limit, so a block compares only against the owner's other blocks.
- **Context is re-read on every call.** A character in a skill body or rules file costs `chars × calls_after`, which `q skills` reports. The heaviest cost is a skill loaded often and left resident, not the longest file.
- **Tool output is the larger half.** Tool results, file contents and conversation outweigh instruction bodies; `avg_result_bytes` in `q tools` measures it.

## 3. Work that held up becomes precedent

A good example teaches more cheaply than a rule. `q exemplars` nominates code an agent wrote that shipped and no later `fix:` commit returned to. A nomination is not a certificate: the label comes from the owner or a review, never from the absence of a fix.

## Cutting guidance

How a line leaves a skill or a rules file:

1. **Find candidates** in the record — `q repeats` for rules restated by hand, `q skills` for bodies that cost the most across their loads.
2. **Decide by reading**, or by the skill set's ablation runner where a line is the only carrier of a behavior. The record never decides: a skill's versions are each loaded in a handful of sessions, and the text changes with the task.
3. **Record the cost** — characters removed times loads in the window.
4. **Check it held** — `q skill <name> --since <date>` shows the new body arriving. It says nothing about whether sessions improved.

A rule leaves `~/.claude/CLAUDE.md` only once a gate holds it, since moving it into a skill cuts its reach to the sessions that load that skill.

## Not goals

- Judging whether a skill made the work better.
- Deriving cost from a pricing table.
- Minimizing context at the cost of the owner's attention.
- Breadth across every agent CLI: two tools, in depth.
