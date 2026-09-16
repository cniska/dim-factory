# Goals

What this repo is for, in order, and how each goal is known to be met. The argument for building it at all is [`dark-factory.md`](dark-factory.md); this page is the operational version of it.

Two goals, and the order between them is load-bearing. The second exists to serve the first.

## 1. Build with less correction

The agent should need correcting less often: fewer stops, fewer times the same instruction has to be repeated, fewer files a later fix has to come back to.

This is the goal the rest of the repo answers to. A change that reduces tokens and raises corrections has failed.

**Measured by** `q corrections` (the mechanical signals that the user stopped the agent), `q rework` (`pushback_rate` — files revisited while the user was pushing back), `q repeats` (phrases typed at the agent across several sessions) and `q fixes` (files a later `fix:` commit returned to).

**The blind spot, stated because it does not go away:** every one of those counts friction that was noticed and acted on. Work that was wrong and accepted looks identical to work that was right ([`findings.md`](findings.md)). These measures can only ever say that visible friction fell.

**What moves it.** A repeated correction is first a question about where the rule lives, and only then about whether the agent obeyed it — the "hack, workaround, band-aid" case is the worked example: the rule existed and had never been delivered to the tool breaking it. So the levers are delivery and mechanism, not more forceful wording:

- Put a rule where it reaches the work. Most file edits carry no skill attribution, so a rule living only in a skill governs a fraction of what it is written for.
- Make a rule mechanical when the event payload decides it. An instruction is re-decided every time; a hook holds whether or not any skill loaded. A hook warns rather than blocks wherever a correct agent could trip it while being right, and a rule needing judgement stays an instruction.
- A heuristic standing in for a fact that lives in another system is not a hook; it is a worse copy of one.

## 2. Spend fewer tokens for the same work

Not to spend less, but to build more within the same budget. Tokens are a capacity constraint on goal 1, which is why this goal ranks second and never overrides it.

**Context is re-read, not sent once.** `q tokens` reports cache reads three orders of magnitude above output, so a character in a skill body or a rules file is paid on every API call it stays resident for. The unit is `chars × calls_after`, which `q skills` reports directly, and it orders skills very differently from body size: the heaviest cost is a skill loaded often and left resident, not the longest file.

**Two halves, very unequal.** Instruction bodies are a small share of what is re-read; tool results, file contents and conversation are most of it. The larger half is governed by which commands run and how much each returns, measured by `avg_result_bytes` in `q tools`, and it is where the least has been done.

**Cutting instruction cost** goes through [`loop.md`](loop.md): the corpus supplies candidates and counts cost, the ablation runner decides, and the check afterward is that the cut held. Each cut is recorded as chars removed × the calls they would have stayed resident for.

Text that changes what an agent does earns its tokens however long it is. Text that changes nothing is waste at any size, and the point of measuring is to tell those apart — never to reward a smaller context that does worse work.

## Not goals

- **Judging whether a skill made the work better.** The corpus cannot: versions are samples of one and the tasks move with the text ([`loop.md`](loop.md) §1). Verdicts come from the ablation runner.
- **Deriving cost from a pricing table.** Cost is reported as each tool reported it. A derived number would read as measured and drift with pricing nobody here controls.
- **Minimizing context.** A cut that raises corrections has failed under goal 1 whatever it saved.
- **Breadth across every agent CLI.** Two tools, in depth. The value is in skills, corrections and rework, not in counting tokens for more tools.
