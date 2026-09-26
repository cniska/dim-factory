# Generating the conventions

A design, not built. It changes `~/.claude/CLAUDE.md`, which governs every session on this machine, so it lands only after a read.

## The cost

The conventions are the most expensive text here. They sit in the system prompt of every session and are re-read on every API call, which puts them ahead of any single skill and within reach of every skill combined. `q skills` orders instruction cost the same way and finds the same shape: what is resident longest costs most, whatever its length.

That makes the file the first place a cut pays, and [`loop.md`](loop.md) already says so. What it cannot say is which lines may go.

## Why a pointer is not a mechanism

The tempting move is to replace a rule with a pointer — "ask the database" instead of stating the rule. It does not work as stated, because a pointer is an instruction too: it is re-decided every session, and a rule that moves out of the conventions and into a skill drops from reaching all work to reaching the fraction that loads that skill. Most file edits carry no skill at all ([`findings.md`](findings.md)), which is how a rule comes to exist and still not arrive.

Three cases, and only the first is a real saving:

- **A gate holds it.** The sentence is deleted. Not shortened, not replaced by a pointer — a hook fires whether or not any skill loaded, so the text describing it is redundant. The commit-subject rule is in this state today, held by `install-commit-gate` in every checkout.
- **It is a body of facts rather than a rule.** What an earlier session decided, what a number was, which version shipped. Facts are unbounded and a query is one line, so here the pointer wins outright: the rule is to ask the record, and `dim q search`, `q keywords` and `q thread` are the asking.
- **It needs judgement.** A comment earning its place, a claim verified at its source, a finding reported as a conclusion. No event payload decides any of these. They stay written, in full, and cutting them buys tokens at the cost of the goal the tokens serve.

## The shape

`~/.claude/CLAUDE.md` splits in two.

The hand-written part is the judgement rules, owned by the owner and edited by hand as now. Nothing generates it and nothing trims it.

The generated part is a block dim writes, naming what it holds mechanically and nothing else — each installed gate contributing the one line a reader needs to know the rule is enforced rather than asked for. Because it is generated from the gates that exist, it cannot claim one that does not, and it shrinks on its own as a rule moves from asked to held.

That inverts today's `install-rules`, which reads the canonical file and flattens it for Codex. The generated block is written into both, so a rule dim holds is announced identically to every tool, and the flattening keeps working for the hand-written half.

## What has to be true before it lands

- A gate exists for the rule being cut, installed everywhere the rule applies, and its absence is visible — a gate that silently fails to install is worse than the sentence it replaced.
- The cut is recorded as chars removed against the calls they would have stayed resident for, as [`loop.md`](loop.md) requires of any cut.
- The hand-written half is never rewritten by a tool. A generated block that can reach the judgement rules is a tool that can quietly change how every session behaves.

## Not built

Nothing generates a block today. The rules with a gate to be held by are the commit subject, the repo's own declared check, a rewrite of the branch the remote's HEAD names, and, in a repo that opts into the [comment gate](usage.md#install-the-shared-controls), a comment added to a JS or TS file — so what is left is the measurement each cut has to be recorded as, not the gates.
