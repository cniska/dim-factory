# The landscape

What else exists, surveyed 2026-09-17, and which part of this repo it reaches. The survey is a web search over public projects and writing, so it can only say what is findable and published — a private line running the same idea is invisible to it, and the judgement of what counts as "the same" is the author's.

The answer splits along the same seam the repo does. The argument in [`factory.md`](factory.md) has been made by other people, in close to the same words. The collector is a crowded field. What was not found anywhere is the join between them: a gate decided by evidence from a corpus rather than by judgement.

## The argument has been made

[Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) draws the distinction this repo draws. Dark is "code ships that no human has read, verified only by other machines"; light keeps human judgement and moves it upstream. It reaches [`factory.md`](factory.md)'s conclusion about which loops may be released — a loop "can earn itself fully automated status only if the check is cheap, runs at high frequency, and relies on something that can't be easily faked out" — against this repo's "each gate earns its automation on its own merit."

The lineage is documented and datable. `cniska/skills` names `addyosmani/agent-skills` as a source some ideas were refined against, and upstream review as a standing maintenance input; that credit entered its README on 2026-04-04, a week after the initial skill set landed on 2026-03-28. The upstream repo's first commit is 2026-02-15. So the channel was open from early on and the stations were not built in ignorance of it.

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

## What to borrow

Each of these is a solved piece of the instrument, not of the factory. None requires adopting anything else from the project it comes from.

| From | Take | Why it fits |
|---|---|---|
| [CASS](https://github.com/jamesqo/coding_agent_session_search) | Reciprocal-rank fusion over the FTS5 and embedding scores, then a bounded rerank | `q search` scores by cosine alone and falls back to keywords. Fusing beats choosing, and [`findings.md`](findings.md) already records the failure mode — a narrow score band on a bad query — that a second signal separates. Not a drop-in: fusion ranks one candidate set twice, and here the two indexes hold different populations — `message_fts` covers every message, `embedding` covers 5,856 distilled passages, and a commit subject is not in `message_fts` at all. The shape that fuses is a second FTS5 index over `embedding.text`, which ranks the same passages by word and by meaning. |
| [code-session-memory](https://github.com/djannot/code-session-memory) | Heading-aware chunking | Already done for the one heading that matters: `distilled.ts` takes a handoff's `## Next` with the same slicer `wake` delivers. What would remain is chunking within a section, and it is latent rather than pressing — the slicer truncates at 700 characters, and no Next in the corpus reaches it (longest 698 on 2026-09-17). Worth taking only if a longer section is embedded, such as a handoff's other headings. Their provider is remote and cannot be taken. |
| [flightlog](https://github.com/RobHudson72/flightlog) | Watch the session directory and index on append | `install-agent` polls every 15 minutes with launchd. A watcher removes both the lag and the macOS-only plist that [`README.md`](../README.md) names as a portability gap. |
| [claudex](https://github.com/utensils/claudex) | Its parser boundary across six agents | Codex has equal standing here, and a third format is what tests whether `parse-*.ts` is a shape or a pair of special cases. |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | `PostToolUse` as an installed event | [`recall.md`](recall.md) names running a formatter after each edit as out of reach because dim installs no such event. This is the precedent that it installs cleanly. |

What not to take: the remote embedding providers, the vector database, the dashboards, and the cost tracking. The first two break the constraint that nothing reaches the network or holds a credential, and the last two answer a question [`goals.md`](goals.md) does not ask.

## What this cannot carry

The survey found no project doing what this one does, which is weaker than the claim that none exists. Search reaches published and indexed work. It does not reach a team running the same argument on an internal corpus, and that is the likeliest place for this to have been built already, since it takes a corpus and a line to be worth building at all.

Novelty is also not the goal the repo is measured against — [`goals.md`](goals.md) sets fewer corrections first and fewer tokens second, and a finding is worth the same whether or not someone else reached it.
