# Design: an instrument that can justify a cut, and a hooks layout

> **Scope.** Two designs share this file, and only one of them is this repo's. The hooks layout — script naming, settings fragments, `install.sh`, fail-open behavior, and the fact that per-skill installs cannot carry hooks — is dim-factory's, and the telemetry hooks in `design.md` are its first consumer. The eval instrument (`evals/run.sh` arms, the rule inventory, scenarios) modifies the tool-agnostic skill set and lands in its own repo, not here; it is kept in this file because the hooks layout was settled in the same pass.
>
> **One correction to the hooks half, from `factory.md`'s own reasoning.** The weakening guard is specified here as a `PostToolUse` hook returning `decision: block`. It must warn instead. A host check is a backstop only if a correct agent cannot trip it while right — and a correct agent deletes a test when the behavior it covered is gone, or moves an assertion. Both trip the guard legitimately, so blocking them fails that test. Feedback the agent can proceed past is the strongest form this check may take.

The eval instrument lands in the skill set's own repo. Prior art: `addyosmani/agent-skills` at `be4e44a9` (2026-09-11). Claude Code hook and CLI facts are cited to `code.claude.com/docs/en/{hooks,cli-reference,headless}.md` and `agent-sdk/{cost-tracking,typescript}.md` as fetched 2026-09-16; line numbers refer to the fetched markdown.

## Decisions in one screen

| Question | Decision |
|---|---|
| What the eval work is for | Deciding which lines inside a loaded skill to cut. Usage frequency is never a defect; it only orders which skills get scenarios first. |
| First slice | A third arm in `evals/run.sh` — `trimmed` = the skill with one addressed line or section removed — plus a rule inventory report that says which lines have an assertion behind them. Nothing else. |
| Cost of testing one cut | 2 arms × k agent calls, plus 2 × k × (judge assertions) short calls. At k=5 with two judge assertions: 10 agent calls, 20 judge calls, roughly a quarter-million tokens, 10–20 minutes serial. Estimates, see §2.4. |
| Run before every cut? | No. Most cuts are made by reading; the runner is for contested cuts where a line is the sole carrier of a contract assertion, or is suspected of making output worse. §2.5 says which kinds fall where. |
| Harm verdict | Falls out of the arm comparison: any assertion the `trimmed` or `none` arm passes more often than `full` (by the same threshold that proves a rule) is reported as harm. No new assertion type needed in slice 1. |
| Model identity | Baseline keyed by the model id `claude -p` reports; a run never compares against another model's numbers. Model *comparison* is a later slice (§4). |
| Routing tier (Tier 2) | Not built now. Description-vocabulary gaps found by the probe are fixed by reading (§5). Revisit only if telemetry shows misroutes the fix-by-reading did not close. |
| Rejected-changes ledger | Not built. Addy's is an empty table (`evals/skill-impact.md`, 6 lines, header only); its purpose is multi-contributor (his `CONTRIBUTING.md:15,66,72`). Here `git log` on `main` is the record (`AGENTS.md:22`). |
| Hooks | One layout for a set: `hooks/<name>.sh`, `hooks/<name>.json` (its settings fragment), `hooks/<name>.test.sh`, one `hooks/README.md`, and `hooks/install.sh <name>…` that merges fragments into a settings file. Per-skill installs cannot carry hooks (§6.1). Weakening guard: later slice. Validate-on-edit hook: rejected. |

## 1. What exists and what it can already say

`evals/run.sh` runs a scenario `k` times with the skill invoked by slash command (`run.sh:142-146`, `invoke` from the scenario at `boundary-discount.sh:10`) and, with `--baseline`, a second arm with skills disabled (`run.sh:25` passes `--disable-slash-commands`; `run.sh:173-176`). It grades cheapest-first — `grep -E` checks (`run.sh:50-58`), then a blinded judge whose `pass` is rejected unless the quoted evidence is a verbatim substring (`run.sh:31-48`) — and gates each assertion's pass rate against `baseline-results.json` (`run.sh:160-168`). The pilot found the bug-finding itself non-discriminative and the skill's *contract* (severity label, finding shape) discriminative at 5/5 vs 0/5 (`evals/README.md:23-31`); every scenario must declare `baseline_must_fail` (`boundary-discount.sh:29`).

What it cannot say today:

- Whether a *particular line* is doing the work. Two arms give skill-vs-nothing; the marginal value of one rule is invisible.
- Whether the skill made anything *worse*. Every assertion is written to be passed by the skill arm, and the `--baseline` arm is only read for `baseline_must_fail` (`run.sh:177-184`); an assertion the no-skill arm passes *more* often is never surfaced.
- Which model produced a number. `run.sh:131` records the CLI version, not the model; `run.sh:26` discards everything in the JSON result except `.result`.

## 2. Slice 1: the trimmed arm and the rule inventory

### 2.1 Delivery channel

All arms load the skill the same way or the comparison is confounded. Today the skill arm relies on the installed skill firing from a slash command; a trimmed text cannot be delivered that way. Decision: every arm runs `claude -p … --disable-slash-commands` (so the installed full skill can never fire; `cli-reference.md:83` "Disable all skills and commands for this session") and the `full` and `trimmed` arms add `--append-system-prompt-file <text>` (`cli-reference.md:69`); the `none` arm adds nothing. The `invoke` field is dropped from scenarios; the task prompt is the same string in all arms.

Consequence: the skill arm's numbers change meaning (system-prompt delivery, not mid-conversation invocation) and `baseline-results.json` is re-recorded. It holds one scenario (`baseline-results.json:1-8`), so this is one `--update-baseline` run.

`--bare` (`cli-reference.md:72`) is not used. It would also drop the user's global `CLAUDE.md`, and the question being asked is "does this line earn its place when the skill loads in *my* sessions", where that file is present. A rule that turns out redundant with `~/.claude/CLAUDE.md` is a true finding under the one-place rule — cut it from the skill.

### 2.2 Addressing a rule

A rule is addressed by a substring that matches exactly one line of `SKILL.md`, the way `Edit` addresses text by `old_string`. The runner removes that line; if the line is a heading, it removes the section through the next heading of equal or higher level. Zero or several matches is a hard error — the scenario names something the skill no longer says, and the proof must be revisited. This needs no markup in shipped text, survives renumbering, and breaks visibly exactly when the rule is reworded.

Granularity is one line. `build/SKILL.md:16-17` are numbered steps carrying several rules each; ablating step 4 removes the verification rule and the weakening rule together. That is accepted for slice 1: if the whole step proves to do work, the follow-up is to split the step into one rule per line — which also reads better — and ablate again.

### 2.3 Smallest change to `run.sh`

- `claude_run` (`run.sh:23-27`) takes a system-prompt file path instead of a `skills` 0/1 flag; empty path means the `none` arm. Always passes `--disable-slash-commands`. Returns the whole JSON so the caller can read `.result`, `.modelUsage`, `.num_turns`, `.total_cost_usd` (fields of the result message: `typescript.md:1282-1300`; `cost-tracking.md:29,63`).
- New `trim_skill <skill.md> <anchor> <out>`: `grep -c -F` for uniqueness, `awk` to drop the line or section. Around fifteen lines.
- New option `--ablate=<anchor>` (repeatable, or the scenario declares `ablate=(…)`). For each anchor `run_arm` runs a third time with the trimmed file.
- The per-scenario print (`run.sh:157-171`) gains one column per arm: `full  trimmed  none`, with the anchor named above the trimmed column.
- Verdict line per assertion: `proven` when `full − trimmed ≥ 40` points; `harm` when `trimmed − full ≥ 40` or `none − full ≥ 40`; otherwise `no effect`. 40 points is two flipped runs at k=5 — the smallest difference that is not one noisy run; at k=3 it is one run and the runner says so in the header. This constant is the honest floor of the instrument, not a tuned nudge.
- `--baseline` stays as the discrimination check; its arm is the same `none` arm, so when `--ablate` is given the three arms come from one run.

Roughly forty lines changed. `run.test.sh` gains: `trim_skill` removes exactly the addressed line, removes a whole section for a heading anchor, fails on zero and on two matches; the verdict function returns `proven`/`harm`/`no effect` at the boundary values. Each test is written so deleting the check it names turns it red.

### 2.4 Cost of testing one candidate cut

The `none` arm is not rerun for a cut decision — its discrimination result is already in the baseline for that scenario. So a cut costs 2 arms:

```
agent calls  = 2 × k
judge calls  = 2 × k × |sem_id|          (run.sh:111 uses this shape for the estimate prompt)
```

Estimates, not measurements — the pilot recorded pass counts, not tokens (`evals/README.md:21-30`): a review-style scenario with a pasted fixture is roughly 15–25k input tokens per agent call (Claude Code's own system prompt dominates; the skill is 1–3k), 1–2k output; a judge call is 2–4k. At k=5, two judge assertions: 10 agent calls ≈ 200k tokens, 20 judge calls ≈ 60k, a few dollars at balanced-tier pricing. Wall clock is serial in `run.sh` (`run.sh:67-75`): 10 × 30–90 s plus 20 × ~10 s ≈ 10–20 minutes. Run the judge on a fast tier pinned with `--model` (§4) to keep the second term cheap.

Power at this k is coarse: 20-point steps, so a rule is `proven` only if removing it flips at least two of five runs. A rule with a subtle effect is undetectable at any k he would pay for. That is a fact about the instrument and shapes §2.5.

### 2.5 Which cuts to test, which to make by reading

Most cuts should be made by reading. The runner is for the contested residue.

By reading, no run — the surviving copy still instructs, so an eval can add nothing beyond what the one-place rule already says:

- A `## Red flags` line mirroring a body rule in the same file: `build/SKILL.md:57` restates `:17`, `:54` restates `:16`, `:55` restates `:19`; `plan/SKILL.md:66-71` (escalating, delegating a grep, trusting a delegate's claim, hiding uncertainty) restate `:11-21`; `explain-diff/SKILL.md:45-60` against `:15-36`; `handoff/SKILL.md:53-70` against `:12-22` ("Prior handoff appended instead of merged" is step 4 negated).
- A `## Rules` section restating the workflow: `pr/SKILL.md:52-59` — all six rules are steps 1, 3, 4, 5 and 7 negated; `issue/SKILL.md:30-36` — three of five are steps 1, 2 and 4 negated; `ship/SKILL.md:57-62` — three of four are steps 1, 5 and 7 negated.
- The same fact in several skills: "comments must earn their keep" in `build:16`, `tdd:15`, `simplify:33`, `style-review:42`, and in `~/.claude/CLAUDE.md`. Keep it where review flags it and where the author writes it; the rest is cost.
- Explanatory prose after an instruction, second and third examples, and any line whose deletion leaves the instruction intact.

By running:

- A line that is the *only* statement of a behavior a contract assertion checks — the severity vocabulary in `correctness-review` is the pilot's example (100% vs 0%). Cutting it on a hunch is where the runner pays for itself.
- A line written to compensate for a suspected model weakness ("verify against docs, not memory", "reproduce before fixing"). These are the ones that expire with a model release; §4 is the workflow.
- A line suspected of *harm* — a checklist the model recites instead of applying, an output format that crowds out the finding. Needs the `none` arm and an assertion about the task's substance, not the skill's structure (the existing `names-trigger` at `boundary-discount.sh:23` is the shape: structure present *and* content substantive; structure without substance is ritual, and it shows up as the sem assertion failing while the det assertion passes).

Not measurable honestly here: "the model would have written it a little better without this line." Detecting that needs blind pairwise preference judging with its own length and position biases; the design stops at assertions the skill arm can lose and says so.

### 2.6 Rule inventory and provenance report

`evals/rules.sh <skill>` (bash + awk, no API) lists every rule-shaped line of the skill — bullets and numbered steps outside frontmatter and `## See also` — with a status:

| Status | Meaning | Source |
|---|---|---|
| `untested` | no assertion names this line | default |
| `claimed` | an assertion names it (`det_rule[i]`/`sem_rule[i]` parallel to `det_id`/`sem_id`, holding an anchor as in §2.2), no ablation recorded | scenario files |
| `proven` | ablation recorded and dropped an assertion by the §2.3 threshold | baseline |
| `no effect` | ablation recorded, nothing moved — the line is cost on every scenario that could exercise it | baseline |
| `harm` | ablation recorded and an assertion *rose* | baseline |

Anchors in `det_rule`/`sem_rule` are validated the same way as `--ablate` anchors (exactly one match), so a reworded rule breaks the mapping loudly. Ablation results are stored in the baseline under the scenario as `trimmed:<anchor>`.

Scale: 715 rule-shaped lines across the 26 skills (counted with `grep -c -E '^\s*[-*] |^\s*[0-9]+\. '`; `review` is the longest file at 134 lines). Mapping all of them by hand will not happen and should not: `untested` is the truthful default, the inventory is complete from day one, and the mapping grows one scenario at a time. Order the work by which skills load most often — the only place frequency matters — and by body length.

The report is one screen per skill: status, line number, first sixty characters. A repo-wide summary line per skill: `proven / claimed / no effect / harm / untested` counts.

### 2.7 Baseline shape and model identity

`baseline-results.json` becomes:

```json
{
  "<model-id from modelUsage>": {
    "correctness-review/boundary-discount": {
      "recorded": "2026-09-16", "k": 5,
      "full":    { "severity-label": 100, "contract-shape": 100, "names-trigger": 100, "no-style-as-bug": 100 },
      "none":    { "severity-label": 0,   "contract-shape": 0,   "names-trigger": 80,  "no-style-as-bug": 100 },
      "trimmed:Order Critical → Fix → Consider → Nit": { "severity-label": 20, "...": 0 }
    }
  }
}
```

The model id is read from the result's `modelUsage` keys (`typescript.md:1300`; whole-tree accounting per `cost-tracking.md:85`). A run compares only against its own model's entry; a missing entry prints `no baseline for <model>` and skips the gate rather than comparing across models. `--update-baseline` writes only its model's subtree. The validator does not scan this file (`validate.sh:81,89` check `SKILL.md` and `README.md` only), so model ids there do not trip the model-name rule.

This replaces the flat shape at `baseline-results.json:1-8`; no dual read.

## 3. Later slice: harm invariants, workspace fixtures, cost measures

Once slice 1 has produced a few verdicts, two additions make harm observable beyond contract assertions. They are not in slice 1 because they need a throwaway workspace and the first skills to test (`correctness-review`, `test-review`, `explain-diff`) produce prose, not edits.

- **Invariant assertions** `inv_id/inv_re/inv_expect`, graded in every arm and required to pass in every arm: the fixture's verify command exits 0, no file outside `allowed_paths` changed (`git status --porcelain`), assertion count in test files did not drop. A `full` arm failing an invariant the `none` arm passes is a harm verdict that needs no judge.
- **Workspace fixtures**: `workspace=<dir>` copied to `mktemp -d`, `git init`, one commit, `claude -p` run with `cwd` there and `--permission-mode acceptEdits` plus an `--allowedTools` list (`headless.md:261-277`), as Addy's `materializeWorkspace` does (`run-evals.js:388-427`). Needed for `build`, `tdd`, `debug`, `simplify`.
- **Cost measures** per arm from the result message — `num_turns`, `total_cost_usd`, files touched — printed as a `full/none` ratio, not gated until there is enough data to know the noise.

## 4. Later slice: models

Kept short because it is real and he will come back to it, but it does not decide which line to cut.

- **Selection.** `--model` takes an alias or a full model name (`cli-reference.md:105`, aliases listed there are `sonnet`, `opus`, `haiku`, `fable`). `run.sh` gains `--model=` for the agent and `--judge-model=` for the judge; the judge is pinned to one fast-tier model across all runs so judge drift never confounds an agent comparison. The set of models is configuration (a list passed on the command line, or a file the Makefile reads), never a constant in the script.
- **The names "luna", "terra", "sol", "astra"** are not in the CLI's alias list and I could not verify them against any Claude model table; treat them as unverified and likely non-Anthropic. Running a non-Claude model needs a replacement for `claude_run` (`run.sh:23-27` is the single API seam) that speaks that model's CLI or API *and* gives it equivalent file and shell tools — the skills assume an agent, not a chat completion. That is a per-provider runner of a few dozen lines plus a tool harness, which is the expensive part; the judge can stay on `claude -p`.
- **Cost control.** Two named sweeps. *Cheap*: one representative scenario per skill, arms `full,none`, k=3, one model — about 26 × 2 × 3 = 156 agent calls plus judge calls; this is the "a new model shipped" run and answers "which assertions are no longer discriminative on it" (rules mapped to those assertions via §2.6 are the deletion candidates — no ablation arm needed for that answer). *Full*: all scenarios, three arms, k=5, the configured model list — cost is `scenarios × 3 × 5 × models` agent calls; run it deliberately, never by default. Incremental skipping (a baseline entry recording the SHA of the skill text and the scenario file; unchanged pairs are not rerun without `--force`) is what keeps the cheap sweep cheap on repeat.
- **Comparability.** Gating is within a model (§2.7). The cross-model view is a separate report: rows scenarios, columns models, cell `full−none` delta on the discriminative assertions — positive means the skill helps on that model, negative means it narrows the model into a worse answer. One screen, one skill at a time.
- **Parallelism.** `run_arm` is serial; a `--jobs=N` over scenarios with `xargs -P` is the only change needed to make the cheap sweep an hour rather than an afternoon.

## 5. Routing tier: not built now

The probe (`scratchpad/probe.js`, re-run 2026-09-16: 19/31 rank-1, collisions `doc-review↔docs` 0.58 and `skill-authoring↔skill-test` 0.50) is a lexical proxy. Its misses split in two: descriptions missing words users say — `debug` lacks flaky/crash/exception/stack trace, `simplify` lacks refactor/duplication/too long, `explain-diff` lacks "walk me through"/"what does this PR change" — and scorer blindness to synonyms a model resolves without help (`security-review` vs "SSRF", `build` vs "step by step"). The first group is fixed by editing three descriptions by hand, today, no tooling. The second group is not a defect.

Given the owner's priorities, a Tier 2 runner does not earn a second language or 250 lines of awk. If it is ever built, the shape is:

- **An awk scorer.** The repo already depends on awk at `validate.sh:34` and `Makefile:5`; Node would add a toolchain pin and a second test runner for one file.
- **Cases at `evals/<skill>/triggers.json`**, invisible to installs, and `run.sh:94` globs only `*.sh` so there is no collision.
- **An owner required on every negative**, because owner-less negatives pass vacuously.
- **A floor stored under a `trigger` key** in the baseline, raised by hand.

Real user turns from session telemetry would enter as `{"prompt", "source": "session", "fired": "<skill|none>"}` after stripping paths, file names, identifiers and pasted output down to the ask.

That `fired` label is the stronger reason not to build the scorer at all: it is a direct routing measurement, so telemetry answers the routing question better than a TF-IDF score, and `fired`-labelled prompts can be graded with no scorer. Cost if built anyway: one to two days plus 26 case files.

## 6. Hooks

### 6.1 Why hooks need their own installation story

`npx skills add` copies one skill directory (`README.md:92`, `AGENTS.md:8`), so nothing outside `skills/<name>/` reaches an install. Skill frontmatter *can* declare hooks (`hooks.md:688-708`, key `hooks:`), but they register when the skill is invoked and then run for the rest of that session (`hooks.md:693`) — the wrong lifecycle for a guard that must run whether or not `build` was ever invoked, and for telemetry that must run from the first turn. Addy sidesteps this with a plugin manifest (`hooks/hooks.json:1-14`, `.claude-plugin/plugin.json`), which this repo does not ship. Decision: hooks install from a clone of this repo into a settings file, separately from skills.

### 6.2 Layout for a set

```
hooks/
  README.md              one table: hook, events, what it does, how it fails
  install.sh             install.sh [--settings <path>] <name>...
  install.test.sh
  <name>.sh              the hook; reads the event JSON on stdin
  <name>.json            its settings fragment, with the literal token HOOKS_DIR for the path
  <name>.test.sh
```

- One hook, one concern, one script; a hook that listens on several events branches on `hook_event_name` (Addy's `simplify-ignore.sh:26-33` reads `tool_name` for the same purpose).
- `install.sh` reads each named fragment, substitutes `HOOKS_DIR` with the absolute path of the clone's `hooks/`, and appends its matcher groups to the target settings (`~/.claude/settings.json` by default; `--settings .claude/settings.json` for a project) with `jq`, written via temp file and `mv`. Idempotent: an entry whose `command` string is already present is not appended. Overlapping events need no merging — Claude Code runs every matching group, so the guard and a telemetry hook each keep their own `PostToolUse` group with matcher `Edit|Write` (`hooks.md:309`). Uninstall is `install.sh --remove <name>`, matched on the same command string.
- Documentation lives in `hooks/README.md` only; each hook's snippet *is* its `.json` file, so the README links to it rather than restating it. Skills do not mention hooks — a skill must work without one, and mentioning a repo-root path breaks the self-contained rule. Root `README.md` gets a short `## Hooks` section pointing at `hooks/README.md`.
- Tests are `*.test.sh` so `make test` finds them (`Makefile:17`) and `make lint` shellchecks them (`Makefile:20`). `install.test.sh`: installing into a temp settings file twice yields byte-identical output; an unrelated pre-existing hook survives; `--remove` deletes exactly the named entry.

### 6.3 Weakening guard — later slice

Backs `build/SKILL.md:17` and `test-review/SKILL.md:41-50` mechanically. `PostToolUse` on `Edit|Write`. Input fields are documented: Edit carries `old_string`/`new_string` (`hooks.md:1690-1692`), Write carries `content` (`hooks.md:1681-1682`); for Write the old text is `git show HEAD:<path>` when tracked. Findings: an added skip or focus marker (`.skip(`, `xit(`, `xdescribe(`, `it.todo`, `@pytest.mark.skip`, `@unittest.skip`, `#[ignore]`, `t.Skip(`, `@Disabled`), an added suppression (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `#[allow(`, `nolint`, `@SuppressWarnings`), a drop in assertion-line count in a file whose path contains `test`, `spec` or `__tests__`, and a lowered number on a line matching `threshold|fail_under|fail-under|coverage`.

Output: exit 0 with `{"decision":"block","reason":"…"}` — for `PostToolUse` that adds the reason next to the tool result while the edit stands (`hooks.md:2029-2030`); exit 2 would do the same via stderr (`hooks.md:893`) but the JSON form is the documented structured route. The reason names the file, the marker, and the counts, and ends with the skill's own instruction: restore the check and fix the code under it, or say why the weakening is intended. Feedback rather than denial because legitimate weakenings exist (`test-review:50` — "unless the diff or commit message says why") and a `PreToolUse` deny would leave the model no way to do a justified deletion through `Edit`.

Fails open: missing `jq`, unparsable stdin, missing fields → exit 0, nothing on stdout; diagnostics on stderr go to the debug log (`hooks.md:822`). Timeout set to 10 s in the fragment (default is 600, `hooks.md:430`). Not covered: files rewritten through `Bash` — `PostToolUse Edit|Write` does not fire for them (`hooks.md:1992`) and `tool_response.bashEditDiff` is documented as best-effort, "not to enforce a policy" (`hooks.md:1637-1641`).

Test file: one payload per marker class that must produce a `block`, a rename-only edit and a test-file edit that adds assertions that must produce nothing, the three fail-open cases, and the Write path against a tracked file in a temp git repo. Removing any single pattern from the script turns its test red.

### 6.4 Validate-on-edit hook — rejected

Running `scripts/validate.sh` when a `SKILL.md` is written would be project-scoped (this repo only), run the same script the `skill-authoring` workflow already runs at step 5 (`skill-authoring/SKILL.md:21`) and CI runs on every push (`ci.yml:16-17`), and there is no record of a validation failure reaching `main` — the validator commits in the log are validator maintenance (`f776575`, `008aaac`, `c7a2823`). `AGENTS.md:12` admits guidance only for friction that repeats; a third run of the same check for friction that has not occurred is scaffolding.

## 7. Documentation changes that ride each slice

- `evals/README.md`: arms and delivery channel (§2.1), anchors (§2.2), verdict threshold (§2.3), the cost formula (§2.4), "cut by reading first" (§2.5), rule statuses (§2.6), baseline shape (§2.7). Drop `invoke` from "Adding a scenario" (`evals/README.md:41`).
- Root `README.md` `## Validate skills` (`README.md:131-141`): one line for `make eval` and `make rules`; new `## Hooks` section when §6.2 lands.
- `AGENTS.md` (through the `agents-md` skill): `## Workflow` gains `make rules`; `## Authoring a skill` gains "a rule that a scenario proves is anchored by a unique substring — reword it and update the scenario in the same commit."
- `skills/skill-authoring/SKILL.md`: step 6 gains "for a cut to a proven line, run the trimmed arm first."
- `Makefile`: `rules` target; `eval` unchanged (`Makefile:13-14`).

## 8. Build order

Each slice is one commit on `main`, verified by `make validate && make test && make lint`.

1. `feat(evals): key baseline by model id` — `claude_run` returns whole JSON; model id from `modelUsage`; new baseline shape; gate only within model; re-record `boundary-discount`. Tests for the key and the "no baseline for model" path.
2. `feat(evals): load skill via system prompt file` — all arms `--disable-slash-commands`; `full`/`trimmed` via `--append-system-prompt-file`; drop `invoke`. Re-record.
3. `feat(evals): trimmed arm` — `trim_skill`, `--ablate=`, per-arm columns, `proven`/`harm`/`no effect` verdicts, `trimmed:<anchor>` in baseline. Tests as in §2.3.
4. `feat(evals): rule inventory report` — `evals/rules.sh`, `det_rule`/`sem_rule`, anchor validation, `make rules`. Test: a scenario naming a non-unique anchor fails; statuses derive correctly from a fixture baseline.
5. `docs(evals): trimmed arm and cut-by-reading` — §7 doc changes for 1–4.
6. Scenarios, one at a time, for the skills loaded most: `test-review` (weakened-checks contract, prose output), `explain-diff`, `review`. Each declares `baseline_must_fail` and at least one `det_rule`/`sem_rule` anchor. Run `--ablate` on the lines the owner already suspects.
7. `feat(hooks): install script and layout` — `hooks/install.sh`, `hooks/README.md`, root README section. This is the piece the telemetry hooks need.
8. `feat(hooks): weakening guard` — §6.3.
9. Later, on demand: §3 (invariants, workspaces, cost measures), §4 (`--model`, `--judge-model`, `--jobs`, incremental skip, cross-model report), §5 only if telemetry shows routing misses that editing descriptions did not close.

## 9. Open points, one line each

- Whether `--disable-slash-commands` also suppresses skills loaded from `~/.claude/skills` in `-p` mode is asserted by the CLI reference (`cli-reference.md:83`) but not tested here; slice 2 verifies it with a run whose `none` arm must not show the skill's contract.
- Per-call token figures in §2.4 are estimates; slice 1 records `total_cost_usd` per arm so the next version of this memo can replace them with measurements.
- The 40-point verdict threshold is the two-run floor at k=5; if scenarios settle on k=3 it becomes 67 and the runner should print the threshold it applied.
