# Goals

What the factory is for, in order, and how each goal is known to be met. The argument for building it at all is [`factory.md`](factory.md); this page is the operational version of it.

Three goals. All of them are about time, which is the commodity actually being spent: the owner's hours going into a build, and the hours lost when work stops. The order is load-bearing — the second and third exist to serve the first.

## 1. Make building take less of the owner's time and effort

The work is several repos, each its own production line, and the currency is attention, not output volume. A change succeeds when shipping the same thing costs fewer of the owner's minutes and less of his thinking — fewer things to re-explain, fewer decisions handed back, less re-deriving what is already known.

**Measured first by `q repeats`:** a phrase typed at the agent across several sessions means the point did not land the first time. Saying a thing twice is unambiguous waste, it names its own fix, and it is the one correction signal with no interpretation in it.

**A stop is not a correction.** Of the turns the user physically stopped, the large majority are bare interrupts carrying no text, and only a handful carry written feedback. An interrupt means "stop" and nothing more — it may be a redirect, a new idea, or added context, so the count alone cannot say the agent was wrong. A message queued while the agent works is not an interrupt and does not appear here. `q corrections` splits `rejected`, `interrupted` and `with_feedback` for exactly this reason; the written feedback is the column that carries a reason, and the total carries none.

**Also measured by** `q rework` (files revisited while the user was pushing back) and `q fixes` (files a later `fix:` commit returned to).

**The blind spot, stated because it does not go away:** all of these count friction that was noticed and acted on. Work that was wrong and accepted looks identical to work that was right ([`findings.md`](findings.md)).

**What moves it.** A repeated correction is first a question about where the rule lives, and only then about whether the agent obeyed it. So the levers are delivery and mechanism, not more forceful wording:

- Put a rule where it reaches the work. Most file edits carry no skill attribution, so a rule living only in a skill governs a fraction of what it is written for.
- Make a rule mechanical when the event payload decides it. An instruction is re-decided every time; a hook holds whether or not any skill loaded. A hook warns rather than blocks wherever a correct agent could trip it while being right, and a rule needing judgement stays an instruction.
- Get a known fact to the moment it is needed. A fact the record already holds, arriving after the work was redone, cost the same attention as not having it.
- A heuristic standing in for a fact that lives in another system is not a hook; it is a worse copy of one.

## 2. Stay clear of the limits, so work does not stop

Not to spend less for its own sake, but to fit more work inside the budget before usage limits halt it. A limit reached stops the build and costs the owner the wait, which is why this is a time goal like the first, and why it ranks second without ever overriding it.

**Measured by `q burn`:** spend against edits per rolling five-hour block, which is the shape a usage limit is measured in. Nothing in the schema records a rate limit, a quota or a refusal, so no query can say how close a window came to stopping — what a block supports is comparison against the owner's other blocks, which is enough to say whether a stretch of work turned spend into changes.

**Context is re-read, not sent once.** `q tokens` reports cache reads three orders of magnitude above output, so a character in a skill body or a rules file is paid on every API call it stays resident for. The unit is `chars × calls_after`, which `q skills` reports directly, and it orders skills very differently from body size: the heaviest cost is a skill loaded often and left resident, not the longest file.

**Two halves, very unequal.** Instruction bodies are a small share of what is re-read; tool results, file contents and conversation are most of it. The larger half is governed by which commands run and how much each returns, measured by `avg_result_bytes` in `q tools`, and it is where the least has been done.

**Cutting instruction cost** goes through [`loop.md`](loop.md): the corpus supplies candidates and counts cost, the ablation runner decides, and the check afterward is that the cut held.

Text that changes what an agent does earns its tokens however long it is. Text that changes nothing is waste at any size.

## 3. Turn work that went well into examples the next build can use

A good example teaches an agent more cheaply than a rule describing the same thing, and the corpus already holds every change this machine has made. The goal is that shipped work which held up becomes reachable as precedent, rather than being rediscovered.

**What the corpus can do:** nominate, through `q exemplars` — code an agent wrote that shipped and that no later `fix:` commit returned to, the same join `q fixes` reads in the other direction. It spans every line on the machine, so a precedent set in one repo is reachable from another, which is how these lines already teach each other one release doc at a time.

**What it cannot do:** certify. Work nobody came back to may still be wrong, and a fix may land on code the session never wrote. An unlabeled nomination promoted to "good example" trains the next build on whatever went unnoticed, so the label comes from the owner or from a review, never from the absence of a fix alone.

Met when a build can be pointed at precedent chosen on evidence, and when the nomination step is cheap enough that labeling is the only manual part.

## A standing constraint

Every query states what it cannot say. This is not modesty: a number that reads as measured but is not will be acted on, and today the footers are what stop version-over-version comparisons, unverifiable savings claims and stop-counts from being read as verdicts. An instrument that overstates is worse than no instrument, because [`factory.md`](factory.md) puts verification at the center of which gates may ever go dark.

## Not goals

- **Judging whether a skill made the work better.** The corpus cannot: versions are samples of one and the tasks move with the text ([`loop.md`](loop.md) §1). Verdicts come from the ablation runner.
- **Deriving cost from a pricing table.** Cost is reported as each tool reported it.
- **Minimizing context.** A cut that costs the owner attention has failed under goal 1 whatever it saved.
- **Breadth across every agent CLI.** Two tools, in depth.
