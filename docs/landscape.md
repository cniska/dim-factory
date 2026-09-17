# The landscape

What else exists, surveyed 2026-09-17, and which part of this repo it reaches. The survey is a web search over public projects and writing, so it can only say what is findable and published — a private line running the same idea is invisible to it, and the judgement of what counts as "the same" is the author's.

The answer splits along the same seam the repo does. The argument in [`factory.md`](factory.md) has been made by other people, in close to the same words. The collector is a crowded field. What was not found is the join between them: a gate whose rule is decided by evidence read out of a session corpus. One project gates on a record of past failures, and [what it reads](#a-gate-that-reads-a-record-of-past-failures) is the distance left.

## The argument has been made

[Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) draws the distinction this repo draws. Dark is "code ships that no human has read, verified only by other machines"; light keeps human judgement and moves it upstream. It reaches [`factory.md`](factory.md)'s conclusion about which loops may be released — a loop "can earn itself fully automated status only if the check is cheap, runs at high frequency, and relies on something that can't be easily faked out" — against this repo's "each gate earns its automation on its own merit."

[Its skills](https://github.com/addyosmani/agent-skills) are the nearest published neighbor to the owner's own tool-agnostic set. What matters here is only the line that set draws against this repo: a skill that works on a machine with no database lives with the others, and a skill that reads the record is a station and lives here.

Its `code-simplification` skill, read on 2026-09-17 from its `SKILL.md`, is the clearest case of what a portable skill can and cannot reach. The changing half is thoroughly worked out — principles that hold behavior fixed, a Chesterton's-fence step before touching anything, tables of signals to look for, a verification checklist whose first line is that the tests pass unmodified, and a list of when not to simplify at all. Its only outside input is the project's own conventions file. Nothing tells it which code is worth the pass, nor when to run at all. The second of those is answered here by `dim-build` running it over every slice ([`design.md`](design.md)); the first is what [`build-order.md`](build-order.md) still queues, aimed by the record.

Neither that set nor any other surveyed here holds anything on sessions — no handoff between them, no search over them, no test for whether a skill earns its place — which is the same gap the collectors below leave open from the other side.

The surrounding writing is dense: [BCG Platinion](https://www.bcgplatinion.com/insights/the-agentic-software-factory) on the agentic software factory, [an arXiv survey](https://arxiv.org/pdf/2602.20979) of agent-infused ecosystems, and a body of vendor and blog writing on dark-factory codebases. Stations with entry and exit contracts, a human retaining approval on high-risk paths, auto-approval under measurable conditions — none of it is novel as of this date.

So the metaphor is not the contribution, and neither is the position that the answer is dim rather than dark. Both are held widely enough that holding them is evidence of being right rather than of being first.

## What was not found is the instrument

Osmani's essay proposes no measurement. It closes on judgement: "The hard, skilled job is deciding where to put each switch." The governance writing sets its thresholds by policy — critical paths get a human, low-risk actions get auto-approval — and the threshold is asserted rather than derived.

This repo answers the same question from a record. [`goals.md`](goals.md) states what the factory is measured against, [`findings.md`](findings.md) is what the corpus said when asked, [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether a rule earns its place, and [`loop.md`](loop.md) is how one gets cut. A finding like *a rule can be missing rather than ignored* — a convention that never reached the tool that was breaking it — is not reachable from an essay, because it requires the transcripts.

No surveyed project makes that join. The people arguing the position are not instrumenting it, and the people instrumenting sessions are not arguing a position — [claude-gates](#a-gate-that-reads-a-record-of-past-failures) comes closest and reads a log it writes itself rather than the sessions.

A source-level survey reaches the same place from the other side. [Inside the Scaffold](https://arxiv.org/abs/2604.03515) (Rombaut, April 2026) reads 13 open-source coding-agent scaffolds at pinned commit hashes across 12 dimensions, one of which is persistent memory — added mid-study "after the source code revealed architectural variation not captured by the initial set", prompted by Aider's conventions files, with agents that have no inter-session storage recorded as absent rather than omitted. What it finds there is static project instructions and the model as memory author. No scaffold feeds what it stores back into anything that refuses. It is also the source-level reading this survey admits it is not, since every row below is a README.

## The collectors do not reach a gate

Every tool below reads session files into a local index and answers questions about them. Each was read at its README on 2026-09-17.

| Project | Reads | Retrieval | Beyond reading |
|---|---|---|---|
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | 26 agents, named individually | BM25 with prefix matching, optional local MiniLM, combined by reciprocal rank fusion | An interactive TUI; a `--robot` JSON surface with `capabilities`, `introspect` and `robot-docs`; and `cass pack`, a token-budgeted handoff of cited evidence |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview) | 40+ agents | FTS5, opt-in remote embeddings | SQLite, Postgres and DuckDB backends; cost and velocity dashboards |
| [claudex](https://github.com/utensils/claudex) | Six agents | Full-text | Installs a skill so agents can query it |
| [flightlog](https://github.com/RobHudson72/flightlog) | Claude Code | MCP tools over indexed blocks | Watches files and indexes on append |
| [code-session-memory](https://github.com/djannot/code-session-memory) | Claude Code, Codex | Remote embeddings into sqlite-vec or pgvector | Installs a skill teaching agents when to query |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | Claude Code | — | Installs `PostToolUse` and `UserPromptSubmit` hooks, purely to observe |

Two of them install something into an agent, so "nobody else installs" is not the distinction. `claudex` and `code-session-memory` install a skill that teaches an agent to query them, and `claude-code-analytics` installs hooks that record. What none of them installs is a rule that holds: no commit-subject gate, no conventions flattened into a second tool's rules file, no `doctor` failing on a channel that silently stopped working. Their hooks report; the hooks here are what makes mechanical what a skill can only instruct.

CASS is the closest on the query path and is further along than this repo on ranking — fusion of a word score and a meaning score against a plain cosine. That gap is worth reading before `q search` is tuned, and it is a gap on the instrument rather than on the factory.

## A gate that reads a record of past failures

[claude-gates](https://github.com/DevRik99/claude-gates) is the one project found on the gates side rather than the collector side: 50 gates in 11 families, all on `PreToolUse`, each matching gate in its own process. Its `recurrence-lock` is the near miss for the join above — a defect **class** is registered in `.ai/reincidencias.json`, which the gate "reads to block mutating work until the class is closed at the root". A gate deciding from a record of what went wrong before is the shape this repo argues for, built by someone else.

Three things separate it from the join, and all three are what the record here is for. The log it reads is one a person appends on purpose, not sessions collected whether or not anyone thought to write anything down. It decides by pattern — DENY where "the action is deterministically wrong", WARN where it "needs judgment" — where [`AGENTS.md`](../AGENTS.md) sends a judgement call to an agent with a fixed brief and keeps the gate for shapes. And its docs state no exit-code contract, where a hook here may only ever fail on something it has read and understood.

Its split of deny from warn is worth keeping in view: it draws the same line this repo draws between what a gate can hold and what needs a reader, and it draws it inside one system rather than across two.

## Where recall differs

Every retrieval tool surveyed is pull-only. CASS is a CLI a person runs. `flightlog` and `code-session-memory` are MCP tools an agent chooses to call, and both ship a skill precisely because the agent has to be taught to choose.

That inherits the reach of whatever invoked it, which is the problem [`recall.md`](recall.md) is about: the sessions that most need a fact are the ones with no reason to suspect it exists. `dim wake` on `SessionStart` is the one channel here that arrives without being asked, and no surveyed project has an equivalent.

CASS is the sharpest case, because it is furthest along on everything except arriving. `cass pack` assembles a token-budgeted answer of cited excerpts, each carrying a trust tier and a freshness policy, which is most of what the stations here assemble by hand — and it still has to be run.

This is a difference in mechanism, not a measured advantage. Nothing here shows the arriving channel pays for its tokens more often than a well-taught pull tool would; `dim q skill handoff` is the measurement, and it has not settled the question.

Which is the survey's most useful result, and it is not a borrow. The one thing here that no surveyed project has is the thing with no number against it, so the move this implies is measuring the channel that already exists rather than importing another — the same order [`build-order.md`](build-order.md) arrives at from the dependencies.

## What to borrow

In this order. Each is a solved piece of the instrument rather than of the factory, and neither requires adopting anything else from the project it comes from.

| From | Take | Why, and what it waits on |
|---|---|---|
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | `PostToolUse` as an installed event | The most leverage for the least work, and it waits on nothing: one installed event unblocks every item [`build-order.md`](build-order.md) lists as waiting on it. The precedent is that it installs cleanly, not that it reports — a hook here records and a later pass commits, the way the session hooks spool rather than write, because a hook firing on every tool call that can fail is a hook that can break every session. |
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | Reciprocal-rank fusion over the FTS5 and embedding scores, then a bounded rerank | The only borrow that touches a measured defect: [`findings.md`](findings.md) records the failure mode — a narrow score band on a bad query — that a second signal separates, and CASS is genuinely further along here. Not a drop-in: fusion ranks one candidate set twice, and the two indexes hold different populations — `message_fts` covers every message, `embedding` covers the distilled passages, and a commit subject is in no FTS index at all. The shape that fuses is a second FTS5 index over `embedding.text`, ranking the same passages by word and by meaning. `dim bench` can now say whether it pays: the measured failure is a paraphrase the index misses while matching a shared word elsewhere ([`findings.md`](findings.md)), which is the case a word signal alone does not fix either. |
| [Superpowers](https://github.com/obra/superpowers) | A stuck-slice counter, and re-stating a station's brief after compaction | The nearest prior art the stations have, and it predates them: its workflow skills hand off between deciding, building under test and proving done, which is the shape of `dim-feat`, `dim-fix`, `dim-build` and `dim-review`. What it keeps is design docs and worktrees, so it can answer what this change is for and not what the machine already did — and its own docs record the hole, that a session-start bootstrap is lost after compaction where the harness has no post-compaction hook. That is this repo's premise, written by the author of the thing it answers. Read on 2026-09-17 from its README and docs rather than its source. |

## What not to borrow

Recorded with the reason, so the same survey does not produce the same suggestion twice.

| From | Leave | Why |
|---|---|---|
| [flightlog](https://github.com/RobHudson72/flightlog) | Watching the session directory and indexing on append | It is a daemon, and no daemon is a constraint the whole read path leans on. What it buys is the few minutes of lag behind a live session, which `dim sync` already closes on demand. The macOS-only plist is a real portability gap and a watcher is not the only fix for it. |
| [claudex](https://github.com/utensils/claudex) | Its parser boundary across six agents | Breadth across every agent CLI is a stated non-goal ([`goals.md`](goals.md)): two tools, in depth. The reasoning is otherwise sound — a third format would test whether `parse-*.ts` is a shape or a pair of special cases — so take that test against a synthetic third format rather than by supporting a third tool. |
| [code-session-memory](https://github.com/djannot/code-session-memory) | Chunking within a section | Already done for the heading that matters: `distilled.ts` takes a handoff's `## Next` with the same slicer `wake` delivers. Chunking below that is latent — the slicer truncates at 700 characters and no Next in the corpus reaches it (longest 698 on 2026-09-17) — so it becomes worth taking only when a longer section is embedded. |
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | A background indexer committing incrementally, so a pass resumes rather than re-reads | `text_sha` and the model id already make a re-run embed only what changed; resuming would save the re-read, which is seconds ([`design.md`](design.md)). |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview), [code-session-memory](https://github.com/djannot/code-session-memory) | Remote embedding providers, and a vector database | Both break the constraint that nothing reaches the network or holds a credential. A local model and a blob column are what keep it. |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview) | Dashboards and cost tracking | They answer a question [`goals.md`](goals.md) does not ask, and cost is reported only as each tool reported it. |
| [Ferment](https://docs.kimchi.dev/docs/coding-ferment) | A letter grade from the judging agent | Its judge grades each step A-F and a low grade can block the next phase, with no stated threshold. A grade cannot be earned the way a checker here earns trust — plant a defect, watch it be caught, take it out — and a cutoff no test can prove is the hardcoded nudge [`AGENTS.md`](../AGENTS.md) warns about. A finding is present or absent, which keeps it falsifiable. Read on 2026-09-17 from its docs rather than its source. |

## Gas Town, read at arm's length

[Gas Town](https://github.com/gastownhall/gastown) orchestrates many coding-agent instances against one codebase, and its concerns are the ones that appear at that scale: spawn capacity, merge contention, agents that get stuck. Read on 2026-09-17 from its README and press coverage rather than its source, so every mechanism named below is a claim about code nobody here has opened, and none of it is a basis for a decision until someone does.

Nothing has been taken, and the one thing worth recording is not a mechanism. Its "Seance" has an agent discover earlier sessions and ask a predecessor what it decided, rather than re-reading the codebase — which is this repo's collector and `q resume`, arrived at independently. That is the only external evidence found so far that the premise holds rather than merely appealing. It also lands in the same place: a seance helps the agent who thought to hold one, which is the gap [`findings.md`](findings.md) measures from the other side, where guidance that exists is in context for a third of the sessions doing the work it covers. Their answer is to ask a predecessor and this one's is to read a record, and neither reaches the agent who asks nothing.

Two things were considered and left. Bisecting a failed batch to find which change broke it is the right shape for a gate that admits more than one change at a time, and nothing here is one — slices are serial, so the item would be a design for a problem this repo does not have. Their watchdog tiers supervise unattended agents, which becomes a real question here only once something runs on a schedule ([`build-order.md`](build-order.md)); the answer would still be a gate that refuses rather than a witness that nudges, because a gate needs nothing to be watching.

Its vocabulary is the clearest thing not to take. A reader cannot follow those docs without first learning a private dialect, which is the cost [`AGENTS.md`](../AGENTS.md) names when it asks for plain words in place of a metaphor standing in for a mechanism.

## An invariant reached independently

[agent-working-memory](https://github.com/CompleteIdeas/agent-working-memory) answers an empty recall with `RECALL ABSTAINED` and the withheld count, in its own words "rather than claiming the memory is absent", and claims 90% correct abstention on questions about facts never stored. That is this repo's rule — every query states the base its numbers came from, and one with nothing to report says so rather than printing a zero — reached separately and with a number against it, which is more than there is here. The number is theirs and unverified on this machine; what carries is that someone else found the same failure worth engineering against.

Its stack is the same shape too, and local for the same reason: SQLite with FTS5, bge-small-en-v1.5 embeddings and an ms-marco cross-encoder through ONNX, with ACT-R decay deciding what fades. The decay is the part this repo does not have and does not want — a record whose job is to say what happened cannot forget on a schedule.

With the Gas Town seance above, that is two external projects arriving at a premise this repo argues from measurement, which is the only outside evidence found that the premise holds rather than merely appeals.

## What this cannot carry

The survey found no project doing what this one does, which is weaker than the claim that none exists. Search reaches published and indexed work. It does not reach a team running the same argument on an internal corpus, and that is the likeliest place for this to have been built already, since it takes a corpus and a line to be worth building at all.

Novelty is also not the goal the repo is measured against — [`goals.md`](goals.md) sets fewer corrections first and fewer tokens second, and a finding is worth the same whether or not someone else reached it.
