# Agent anti-patterns

Shapes coding agents keep writing, and the fix for each. An agent copies the code nearest its change, so one instance left standing becomes the next change's template. Code an agent writes is rid of every entry here before it lands, and an instance found in merged code is fixed rather than left as precedent.

The entries are the owner's corrections to agents across their projects, quoted from the record; the examples are from this repository. Each names what holds it: a type or constraint where one can, otherwise review. A review dimension reading against this page is in [`todo.md`](todo.md).

## A workaround in place of the cause

A hack, band-aid or special case that makes the symptom go away while the defect stays. It is the pushback the record holds most often: "dont EVER add hacks and ducttape in this project".

**Fix.** Find the cause and fix it so the symptom cannot recur. Where the cause is out of reach, stop and say so; a workaround is never the fallback plan.

**Holds it.** Review, and the comment ban below, which leaves a workaround no place to be excused.

## One act with more than one code path

The same thing done by two routes — a synchronous twin beside the live runner, a CLI command that writes what a runner already writes. Every change has to be made twice and drifts where it is not, and each route grows guards against the other: a refusal code whose only job is to catch the wrong route reaching the act, such as `build_artifact_before_final_slice`.

"all paths should go through the same logic here right? otherwise we get bugs like this".

**Fix.** One path per act. Delete the second route and move its callers, tests included, onto the first; a check written for the deleted route goes with it. Where two cases differ, only the parameter that differs varies.

**Holds it.** Review. A new function beside an existing one that does the same act is the finding.

## A concept modelled as something it is not

A thing is made to fit an existing concept because the shape was already there: shipping, an act the operator runs once every station is done, stored as a fourth station an order is moved to. The borrowed concept's rules then apply to something they do not describe, and every reader special-cases it. The same shape is a state invented to paper over a gap — a "ready to resume" flag where the order's real status was missing.

**Fix.** Give it its own concept, its own word in [`glossary.md`](glossary.md), and its own code. Shipping is `dim order ship`, gated on its own entry conditions; the stations are `plan`, `build` and `review`.

**Holds it.** The closed vocabulary of the concept it was borrowed from ([`src/station.ts`](../src/station.ts) and its `CHECK`), and review of any new member proposed for one.

## A code comment

A comment is where an agent excuses what the code should have fixed. A comment explaining why an odd line is fine makes the odd line look settled, so nobody fixes its cause, and the next agent copies both the line and its excuse. A comment carrying a design's rationale is a second copy of what the owning doc says, and the two drift apart. The rest narrate what the line below already says, and an agent matches the comment density of the file it is editing, so they multiply.

**Fix.** No comments, tool contracts aside. A why goes into a name, a test that holds the invariant, or the doc that owns the subject. A comment defending a workaround is not moved into a doc, which only relocates the excuse: the workaround is fixed, or filed in [`todo.md`](todo.md).

**Holds it.** The comment gate, in a repo that bans comments: the commit gate refuses a commit adding one to a JS or TS line ([`usage.md`](usage.md#install-the-shared-controls)), and the runner refuses a factory builder's turn that adds one ([`factory.md`](factory.md)).

## A gate on the step before the act

A check placed on the move that usually precedes an act rather than on the act: the operator and review checks on moving an order to ship, while `dim order ship` itself trusted that the move had happened. Any other route to the act is unguarded.

**Fix.** The act checks its own entry conditions from the record. The step before it has nothing left to guard and usually goes.

**Holds it.** Review.

## A free-text type for a closed set

`station: string` where the concept has exactly three members. It is what let two spellings and a non-member into the record.

**Fix.** A closed type and the matching `CHECK`, so the compiler and the database both refuse a value outside it.

**Holds it.** The type and the constraint, once written.

## Two words for one concept

`dim-station-plan` and `plan` both stored as the station; "workspace command" and "command" meaning different things. Every reader has to accept both, and a third spelling follows. "the same concept shouldnt carry two names".

**Fix.** One word, the ecosystem's own where one exists, settled in [`glossary.md`](glossary.md), and a rename of every other use in the same change with no alias kept for the old one.

**Holds it.** The glossary, and a closed type where the concept has one.

## A fallback for a value the source should require

`finding.fix ? … : ""`, `severity ?? "no severity recorded"`, a fallback model or a second route tried when the first fails: code tolerating an absence or a failure that should never have been allowed. Each tolerant reader invites the next writer to leave the value out. "id drop any fallbacks that arent strictly needed, they only add tech debt".

**Fix.** Make the value required where it is written — `NOT NULL`, a required field, a parser that refuses — and delete every fallback downstream in the same change.

**Holds it.** The constraint at the source; the type then leaves the fallback unreachable.

## The same fact stored twice

An owner's approval kept as a verdict row, an event repeating its decision, and the approval event itself. The copies disagree the first time one write is missed. "duplicating state is not good".

**Fix.** One row per fact, and every other view of it read from that row.

**Holds it.** Review, against the rule in [`design.md`](design.md) that each column has one canonical source.

## A heuristic where a record or the model should decide

A regex, a word list or text parsing standing in for a field the record already holds, a structured output, or a judgement the model should make. "the model should make the decisions not heuristics".

**Fix.** Read the recorded field, have the worker return structured JSON, or give the judgement to an agent with a fixed brief ([`AGENTS.md`](../AGENTS.md)).

**Holds it.** Review.

## Reinventing what already exists

A new component, field, helper or format written beside one the codebase already has. "why are you adding another abstraction when there is already a system for this?"

**Fix.** Look for prior art before writing — `dim q prior-art` across the repos on disk — and reuse it.

**Holds it.** The plan station's prior-art step, and review.

## Indirection with one use

A wrapper, layer or helper with a single caller, adding a name to learn and nothing to reuse. "a single use probably doesnt justify abstraction. id inline instead".

**Fix.** Inline it, and add structure when a second real use arrives.

**Holds it.** Review and the simplification pass.

## Hand-tuned values instead of structure

A `calc()` nudge, a magic number or an absolute offset where the layout or a design token should decide. "no magic numbers pls".

**Fix.** Fix the layout's structure and use the design system's tokens, so no constant needs tuning.

**Holds it.** Review.

## Compatibility nobody needs

Legacy support, a compatibility shim or a dual read kept for data or callers that a single-owner, greenfield system does not have. "the factory shouldnt have any legacy code at all".

**Fix.** Cut it cleanly. Where old data is in the way, the migration is a step someone takes, not a shape the code keeps.

**Holds it.** Review.

## An error swallowed to keep going

`catch {}`, or a `catch` that rethrows a different error than the one it caught, written because the correct behavior was unclear. The failure it hides is the one the next reader needs. Narrow on purpose: a failure chosen to be silent for an optional value is a decision, not this.

**Fix.** Let it fail where the caller can see it, or handle the one case understood and say why in a name or a test. A degradation chosen on purpose is named as one.

**Holds it.** Review.
