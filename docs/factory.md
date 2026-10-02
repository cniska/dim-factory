# The factory

The argument this repo executes. [`my-workflow.md`](my-workflow.md) is the workflow it replaces; [`goals.md`](goals.md) is what it is measured against.

## Dim, not dark

A factory with no human reading the work ships whatever the checks miss, and the checks do not catch a coherent, confident, wrong design. So:

- **Autonomous between the gates.** Once a direction is agreed, agents read, write, verify and recover without asking at every branch.
- **A human at the gates that matter.** Hard-to-reverse, outward-facing or ambiguous work waits for the owner.
- **Each gate earns its automation from a record.** Every approval and return is an attributed event, so which kinds of work stopped needing a read is a query over verdicts, not a feeling. Reviewing everything is the starting point, because a gate cannot earn its way out of a record never kept.

## Trust across projects

The factory aims to give each project the conditions that let its owner delegate work with evidence:

- **Codebase quality.** Clear boundaries, current docs and tests give a worker a reliable starting point. [`dim-audit`](../skills/dim-audit/SKILL.md) inspects an existing project and reports debt for the owner to turn into work.
- **Static analysis and tests.** The project declares the check it needs; its own hooks and CI run it before accepting code, and the factory's slice gates run it on every commit a worker hands in.
- **Rules.** Standing instructions tell agents what holds throughout a project. Mechanical rules become gates, which still run when an agent misses an instruction ([`usage.md`](usage.md#install-the-shared-controls)).
- **Skills.** Shared, task-specific procedures guide planning, building, review and audit. [`dim-setup`](../.agents/skills/dim-setup/SKILL.md) installs them for use from other projects.
- **Style guide.** The project's conventions and examples show what its code and docs should look like: names, file boundaries, API patterns and writing. Formatting is one enforceable part; reviewers judge conventions that tools cannot decide. [Google's style guide overview](https://github.com/google/styleguide/blob/gh-pages/README.md) uses the term for conventions ranging from names to design choices.

Setup installs the shared controls, while each project supplies its declared check and local conventions. An audit reports codebase quality problems; fixing them remains work with its own evidence and approvals.

## Borrowed from the assembly line

- **Stop on a defect, never on success** (*jidoka*). A slice gate halts a failing change; the operator halts on a second failure of one order.
- **A defect halts its own work** (*andon*). A finding stops its slice until it is answered, and a red check fails the turn it ran on.
- **Fix the process, not the part.** A defect found repeatedly is a gate that does not exist yet.
- **Make the error impossible** (*poka-yoke*). Whatever is mechanical is a gate; judgement goes to an agent with a fixed brief.
- **One piece at a time.** A slice is verified and committed before the next begins.
- **Go and see** (*genchi genbutsu*). A claim is verified at its source.
- **The operator does not work the line.**

Takt time does not transfer: a slice is not an interchangeable unit, and a cadence would manufacture work to fill it.
