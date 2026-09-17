# Design: the loop

How a line gets cut from a skill and stays cut: where a candidate comes from, what is allowed to decide it, and what is measured afterward.

> **Scope.** The join between two instruments that already exist. The corpus and its queries are this repo's ([`design.md`](design.md)); the ablation runner and the rule inventory are `cniska/skills`' ([`evals-and-hooks.md`](evals-and-hooks.md)). Neither changes here. What this adds is the direction evidence is allowed to flow between them, and one report.

## Decisions in one screen

| Question | Decision |
|---|---|
| Can the corpus judge a cut? | No. Skill versions are samples of one, and the tasks differ with the text. The corpus never returns a verdict. |
| What does the corpus decide? | Which line to question, and what it costs to ship. Both are cheap and complete. |
| What decides the cut? | The ablation runner, or reading. Nothing else. |
| What is measured after? | Cost, which is arithmetic, and whether the cut held. Never whether sessions improved. |
| Where the loop points first | Reach before body size: a rule in a guidance file reaches every edit, a rule in a skill reaches the loads of that skill. |
| Cadence | Per skill, when its cost is questioned. Not scheduled, not swept. |

## 1. Why the obvious loop does not work

The loop to reach for is: cut a line, watch the next weeks of sessions, keep the cut if things got better. Every part of the corpus refuses it.

`q skill <name>` splits a skill by the hash of the body loaded in each session. `handoff` carries 90 versions in a 30-day window and 83 of them were loaded in exactly one session; across the whole corpus it is 132 and 121 ([`findings.md`](findings.md), "A skill's versions are arms of one"). An arm of one is not an arm. Worse, the versions are not randomly assigned: a skill is edited *because* of the session it was in, so the text and the task move together, and the direction of that confound is unknowable from the rows.

`q corrections` and `q rework` have the same shape one level down. A stop recorded under a version is an act the user took, not a judgement that the skill was wrong, and the tool's own footer says so. So no query here returns "this version was better", and none should be built to.

**Consequence.** The corpus is disqualified as a verdict on a cut, permanently and by structure, not for want of data. It keeps two jobs that need no verdict.

## 2. The two jobs the corpus does keep

**Candidates.** Which lines are worth questioning at all. These come from evidence of a rule failing to land, never from a rule being disliked:

- `q repeats` — a phrase the user has typed at the agent across several sessions. A repeated correction is first a question about where the rule lives and only then about whether it was obeyed; the 12 "hack" prompts that reached Codex with the rule sitting undelivered in a Claude-only file are the worked example ([`findings.md`](findings.md), "A rule can be missing rather than ignored").
- `q skills` — `body_chars` against `loads`. A long body on a heavily loaded skill is where a cut pays; a long body loaded twice is not worth an eval run.
- `q delegation`, `q fixes`, `q rework` — a skill whose largest block of activity sits under `(no skill)` is a routing question, not a text question, and no cut to its body will move it.

**Cost.** What a line costs to ship, which the corpus knows exactly because it is multiplication: the chars removed, times the loads in the window, is characters that stop being sent. No inference, no arm, no confound. This is the only number in the loop that needs no instrument beyond a query.

## 3. The one thing allowed to decide

A cut is decided by reading, or by the ablation runner — the `full` and `trimmed` arms of `evals/run.sh`, gated at the verdict threshold in [`evals-and-hooks.md`](evals-and-hooks.md) §2.3.

Most cuts are decided by reading, and §2.5 there already says which kinds: a `## Red flags` line mirroring a body rule, a `## Rules` section restating the workflow, the same fact stated in several skills, explanatory prose after an instruction. The corpus can point at these faster than a human scan, but it adds nothing to the decision — the one-place rule already settles them.

The runner is for the contested residue, and the corpus earns its place there by ordering the queue. An eval run costs two arms and ten to twenty minutes; the rule inventory reports 715 rule-shaped lines across the skills. The instrument can never be pointed at all of them, so the question is only ever *which* to point it at, and that is a question about traffic and cost — exactly what the corpus holds.

## 4. The loop

1. **Question a skill.** `q skills` orders by what a body costs across its loads. Read `q skill <name>` before editing: it names the sessions to read, never a version that scored better.
2. **Take the candidates.** `q repeats` for rules that are being restated by hand; the inventory's `untested` and `no effect` rows for lines nothing has ever checked.
3. **Split them.** Redundant against a surviving statement → cut by reading, no run. Sole carrier of a behavior an assertion checks, or suspected of harm → ablate.
4. **Cut, in the skills repo, one commit.** A reworded rule breaks its anchor loudly, so the scenario is updated in the same commit.
5. **Record the cost.** Chars removed × loads in the window. Arithmetic, and the only claim the corpus can make about the cut.
6. **Check it held, not that it helped.** `q skill <name> --since <date of the cut>` shows the new body arriving and the old one falling out of the loads. A rule reappearing under a later hash is the finding — a cut that did not stay cut. Nothing in this step compares outcomes.

Step 6 is where the loop is usually drawn wrong. It closes on **delivery**, not on quality: it answers "is the smaller text what sessions are now loading", which the corpus knows exactly, instead of "did the smaller text work better", which it cannot know.

## 5. Where to point it first

Reach before body size. Most file edits carry no skill attribution at all, so a rule in `AGENTS.md` or `CLAUDE.md` reaches every edit while the same rule in `build/SKILL.md` reaches a few percent of them ([`findings.md`](findings.md), "The stations run a fifth of the work"). The gap has widened since that was measured, never narrowed.

That inverts the obvious order. The heaviest skill bodies are not the best first target; the guidance files are, because a line there is paid on every session and a line in a rarely-loaded skill is nearly free. The skills worth questioning are the ones the corpus shows actually loading — `handoff`, `review`, `git`, `spec` lead `q skills` — and the rest can stay long without costing anything.

**A rule leaves the conventions file only when a gate holds it.** The file is read on every API call of every session, so it is the most expensive text on the machine and the obvious place to cut. But moving a rule into a skill drops its reach from all work to the fraction that loads that skill, which is how a rule comes to exist and still not arrive. So the cut is earned, one rule at a time, by building the mechanism first: a gate fires whether or not any skill loaded, and only then is the sentence describing it redundant. `install-commit-gate` is the worked example — the subject rule is now held by a hook in every checkout, and its sentence is the first that could go.

Most rules will never qualify. A comment earning its place, a claim verified at its source, a finding reported as a conclusion: no event payload decides any of them, and they stay written down. The cut list is short on purpose.

The boundary the runner cannot cross today: it ablates a `SKILL.md` line by delivering trimmed text through `--append-system-prompt-file`, with the user's real `CLAUDE.md` present on purpose. A rule *inside* that file has no such seam, so a guidance-file cut is decided by reading and the one-place rule, and its cost is still exact. Giving the runner a guidance-file arm is a later question and is not answered here.

## 6. What this does not become

- No query that ranks skill versions by an outcome. §1 is the reason, and it does not expire with more data.
- No scheduled sweep. The loop runs when a skill's cost is questioned; a cadence would manufacture cuts to justify itself.
- No model call in the corpus path. The runner makes model calls, in the other repo, where the arms are.
- No verdict carried back into the database. Ablation results live in the eval baseline; duplicating them here would create a second authority that drifts.
