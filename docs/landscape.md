# The landscape

What else exists, surveyed 2026-09-17, and which part of this repo it reaches. The survey is a web search over public projects and writing, so it can only say what is findable and published — a private line running the same idea is invisible to it, and the judgement of what counts as "the same" is the author's.

The answer splits along the same seam the repo does. The argument in [`factory.md`](factory.md) has been made by other people, in close to the same words. The collector is a crowded field. What was not found anywhere is the join between them: a gate decided by evidence from a corpus rather than by judgement.

## The argument has been made

[Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) draws the distinction this repo draws. Dark is "code ships that no human has read, verified only by other machines"; light keeps human judgement and moves it upstream. It reaches [`factory.md`](factory.md)'s conclusion about which loops may be released — a loop "can earn itself fully automated status only if the check is cheap, runs at high frequency, and relies on something that can't be easily faked out" — against this repo's "each gate earns its automation on its own merit."

The lineage is documented and datable. `cniska/skills` names `addyosmani/agent-skills` as a source some ideas were refined against, and upstream review as a standing maintenance input; that credit entered its README on 2026-04-04, a week after the initial skill set landed on 2026-03-28. The upstream repo's first commit is 2026-02-15, which bounds when it could have been visible but not when it was: a first commit is not a publication date, and nothing reachable here says when that repo went public. So which set appeared first is open, and the corpus records the belief that this one did.

What the channel carried is narrow, and the skill sets show it. The two overlap on what any lifecycle has — test-first, debugging, simplification, security, git, deprecation, docs, shipping — and diverge everywhere else. Upstream holds nothing on sessions: no handoff between them, no search over them, no test for whether a skill earns its place. Those are `handoff`, `search-sessions`, `skill-test` and `explain-diff` here, and the five-way split of review into correctness, style, security, architecture and docs is against a single upstream review skill. The instrument this repo is has no upstream counterpart at all.

The surrounding writing is dense: [BCG Platinion](https://www.bcgplatinion.com/insights/the-agentic-software-factory) on the agentic software factory, [an arXiv survey](https://arxiv.org/pdf/2602.20979) of agent-infused ecosystems, and a body of vendor and blog writing on dark-factory codebases. Stations with entry and exit contracts, a human retaining approval on high-risk paths, auto-approval under measurable conditions — none of it is novel as of this date.

So the metaphor is not the contribution, and neither is the position that the answer is dim rather than dark. Both are held widely enough that holding them is evidence of being right rather than of being first.

## What was not found is the instrument

Osmani's essay proposes no measurement. It closes on judgement: "The hard, skilled job is deciding where to put each switch." The governance writing sets its thresholds by policy — critical paths get a human, low-risk actions get auto-approval — and the threshold is asserted rather than derived.

This repo answers the same question from a record. [`goals.md`](goals.md) states what the factory is measured against, [`findings.md`](findings.md) is what the corpus said when asked, [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether a rule earns its place, and [`loop.md`](loop.md) is how one gets cut. A finding like *a rule can be missing rather than ignored* — a convention that never reached the tool that was breaking it — is not reachable from an essay, because it requires the transcripts.

That join is what no surveyed project or piece of writing does. The people arguing the position are not instrumenting it, and the people instrumenting sessions are not arguing a position.

## The collectors do not reach a gate

Every tool below reads session files into SQLite and answers questions about them. Each was read at its README on 2026-09-17.

| Project | Reads | Retrieval | Beyond reading |
|---|---|---|---|
| [CASS](https://github.com/jamesqo/coding_agent_session_search) | Claude Code, Codex | FTS5 and local FastEmbed, rank fusion, cross-encoder rerank | Nothing: states it has no TUI, daemon, analytics or compatibility layer |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview) | 40+ agents | FTS5, opt-in remote embeddings | SQLite, Postgres and DuckDB backends; cost and velocity dashboards |
| [claudex](https://github.com/utensils/claudex) | Six agents | Full-text | Installs a skill so agents can query it |
| [flightlog](https://github.com/RobHudson72/flightlog) | Claude Code | MCP tools over indexed blocks | Watches files and indexes on append |
| [code-session-memory](https://github.com/djannot/code-session-memory) | Claude Code, Codex | Remote embeddings into sqlite-vec or pgvector | Installs a skill teaching agents when to query |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | Claude Code | — | Installs `PostToolUse` and `UserPromptSubmit` hooks, purely to observe |

Two of them install something into an agent, so "nobody else installs" is not the distinction. `claudex` and `code-session-memory` install a skill that teaches an agent to query them, and `claude-code-analytics` installs hooks that record. What none of them installs is a rule that holds: no commit-subject gate, no conventions flattened into a second tool's rules file, no `doctor` failing on a channel that silently stopped working. Their hooks report; the hooks here are what makes mechanical what a skill can only instruct.

CASS is the closest on the query path and is further along than this repo on ranking — fusion and reranking against a plain cosine. That gap is worth reading before `q search` is tuned, and it is a gap on the instrument rather than on the factory.

## Where recall differs

Every retrieval tool surveyed is pull-only. CASS is a CLI a person runs. `flightlog` and `code-session-memory` are MCP tools an agent chooses to call, and both ship a skill precisely because the agent has to be taught to choose.

That inherits the reach of whatever invoked it, which is the problem [`recall.md`](recall.md) is about: the sessions that most need a fact are the ones with no reason to suspect it exists. `dim wake` on `SessionStart` is the one channel here that arrives without being asked, and no surveyed project has an equivalent.

This is a difference in mechanism, not a measured advantage. Nothing here shows the arriving channel pays for its tokens more often than a well-taught pull tool would; `dim q skill handoff` is the measurement, and it has not settled the question.

Which is the survey's most useful result, and it is not a borrow. The one thing here that no surveyed project has is the thing with no number against it, so the move this implies is measuring the channel that already exists rather than importing another — the same order [`build-order.md`](build-order.md) arrives at from the dependencies.

## What to borrow

Two, in this order. Each is a solved piece of the instrument rather than of the factory, and neither requires adopting anything else from the project it comes from.

| From | Take | Why, and what it waits on |
|---|---|---|
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | `PostToolUse` as an installed event | The most leverage for the least work, and it waits on nothing: one installed event unblocks running a formatter after an edit, undoing an agent's writes, and the weakening guard, which are three separate items in [`build-order.md`](build-order.md). The precedent is that it installs cleanly, not that it reports — a hook here records and a later pass commits, the way the session hooks spool rather than write, because a hook firing on every tool call that can fail is a hook that can break every session. |
| [CASS](https://github.com/jamesqo/coding_agent_session_search) | Reciprocal-rank fusion over the FTS5 and embedding scores, then a bounded rerank | The only borrow that touches a measured defect: [`findings.md`](findings.md) records the failure mode — a narrow score band on a bad query — that a second signal separates, and CASS is genuinely further along here. Not a drop-in: fusion ranks one candidate set twice, and the two indexes hold different populations — `message_fts` covers every message, `embedding` covers the distilled passages, and a commit subject is in no FTS index at all. The shape that fuses is a second FTS5 index over `embedding.text`, ranking the same passages by word and by meaning. Waits on the benchmark, or it is tuning by preference. |

## What not to borrow

Recorded with the reason, so the same survey does not produce the same suggestion twice.

| From | Leave | Why |
|---|---|---|
| [flightlog](https://github.com/RobHudson72/flightlog) | Watching the session directory and indexing on append | It is a daemon, and no daemon is a constraint the whole read path leans on. What it buys is the few minutes of lag behind a live session, which `dim sync` already closes on demand and `df-sessions` already tells a reader to run. The macOS-only plist is a real portability gap and a watcher is not the only fix for it. |
| [claudex](https://github.com/utensils/claudex) | Its parser boundary across six agents | Breadth across every agent CLI is a stated non-goal ([`goals.md`](goals.md)): two tools, in depth. The reasoning is otherwise sound — a third format would test whether `parse-*.ts` is a shape or a pair of special cases — so take that test against a synthetic third format rather than by supporting a third tool. |
| [code-session-memory](https://github.com/djannot/code-session-memory) | Chunking within a section | Already done for the heading that matters: `distilled.ts` takes a handoff's `## Next` with the same slicer `wake` delivers. Chunking below that is latent — the slicer truncates at 700 characters and no Next in the corpus reaches it (longest 698 on 2026-09-17) — so it becomes worth taking only when a longer section is embedded. |
| [CASS](https://github.com/jamesqo/coding_agent_session_search) | A cursor for the embedding pass | `text_sha` and the model id already make a re-run embed only what changed; a cursor would save the re-read, which is seconds ([`design.md`](design.md)). |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview), [code-session-memory](https://github.com/djannot/code-session-memory) | Remote embedding providers, and a vector database | Both break the constraint that nothing reaches the network or holds a credential. A local model and a blob column are what keep it. |
| [agentsview](https://github.com/BUKOWSKIREAL/agentsview) | Dashboards and cost tracking | They answer a question [`goals.md`](goals.md) does not ask, and cost is reported only as each tool reported it. |

## What this cannot carry

The survey found no project doing what this one does, which is weaker than the claim that none exists. Search reaches published and indexed work. It does not reach a team running the same argument on an internal corpus, and that is the likeliest place for this to have been built already, since it takes a corpus and a line to be worth building at all.

Novelty is also not the goal the repo is measured against — [`goals.md`](goals.md) sets fewer corrections first and fewer tokens second, and a finding is worth the same whether or not someone else reached it.
