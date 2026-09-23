# The landscape

What else exists, surveyed 2026-09-17–22, and which part of this repo it reaches. The survey is a web search over public projects and writing, so it can only say what is findable and published — a private line running the same idea is invisible to it, and the judgement of what counts as "the same" is the author's.

The answer splits along the same seam the repo does. The argument in [`factory.md`](factory.md) has been made by other people, in close to the same words. The collector is a crowded field. What was not found is the join between them: a gate whose rule is decided by evidence read out of a session corpus. One project gates on a record of past failures, and [what it reads](#a-gate-that-reads-a-record-of-past-failures) is the distance left.

## The argument has been made

[Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) draws the distinction this repo draws. Dark is "code ships that no human has read, verified only by other machines"; light keeps human judgement and moves it upstream. It reaches [`factory.md`](factory.md)'s conclusion about which loops may be released — a loop "can earn itself fully automated status only if the check is cheap, runs at high frequency, and relies on something that can't be easily faked out" — against this repo's "each gate earns its automation on its own merit."

[Its skills](https://github.com/addyosmani/agent-skills) are the nearest published neighbor to the owner's own tool-agnostic set. What matters here is only the line that set draws against this repo: a skill that works on a machine with no database lives with the others, and a skill that reads the record is a station and lives here.

Its `code-simplification` skill, read on 2026-09-17 from its `SKILL.md`, is the clearest case of what a portable skill can and cannot reach. The changing half is thoroughly worked out — principles that hold behavior fixed, a Chesterton's-fence step before touching anything, tables of signals to look for, a verification checklist whose first line is that the tests pass unmodified, and a list of when not to simplify at all. Its only outside input is the project's own conventions file. Nothing tells it which code is worth the pass, nor when to run at all. The second of those is answered here by `dim-station-build` running it over every slice ([`design.md`](design.md)); the first is what [`build-order.md`](build-order.md) still queues, aimed by the record.

Neither that set nor any other surveyed here holds anything on sessions — no handoff between them, no search over them, no test for whether a skill earns its place — which is the same gap the collectors below leave open from the other side.

The surrounding writing is dense: [BCG Platinion](https://www.bcgplatinion.com/insights/the-agentic-software-factory) on the agentic software factory, [an arXiv survey](https://arxiv.org/pdf/2602.20979) of agent-infused ecosystems, and a body of vendor and blog writing on dark-factory codebases. Stations with entry and exit contracts, a human retaining approval on high-risk paths, auto-approval under measurable conditions — none of it is novel as of this date.

So the metaphor is not the contribution, and neither is the position that the answer is dim rather than dark. Both are held widely enough that holding them is evidence of being right rather than of being first.

## Harness engineering closes the factory gap

[Martin Fowler's harness-engineering work](https://martinfowler.com/articles/harness-engineering.html) gives the clearest public vocabulary for the layer between an agent and a repository. It separates feed-forward guides from feedback sensors, and computational sensors from inferential ones. Fast deterministic checks should run close to every change; expensive semantic evaluators should be aimed at the changes and projects where they add confidence; continuous health sensors should look for drift outside the change lifecycle.

[OpenAI's account of building with Codex](https://openai.com/index/harness-engineering/) is a concrete instance of that model. Repository knowledge is treated as the system of record, architecture is enforced with custom linters and structural tests, observability is made legible inside isolated worktrees, agents review agent work, and recurring garbage collection is used to control entropy. This is close to the factory's quality floor and its planned self-maintaining loop.

[Anthropic's long-running harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) adds the execution details: decompose work into tractable chunks, pass structured artifacts between sessions, reset context when necessary, and separate the generator from the evaluator. Its evaluator is not automatically useful; it improves only when its criteria are made concrete and its disagreements with the owner's judgement are used to tune it. [Anthropic's eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) likewise treats the final environment state and the complete trace as evaluation inputs, not merely the agent's final prose.

| Public pattern | This repo's counterpart | Status here |
|---|---|---|
| Feed-forward guides | Project rules, prior art, contracts and the approved plan | Live in the stations; the workflow makes their order explicit |
| Fast computational sensors | Repository checks, schema validation, structural rules and commit gates | Live in part; the factory still needs more project-declared checks |
| Independent inferential sensors | Read-only review dimensions and the Build artifact | Review is live; the artifact gate is partly planned |
| Continuous health sensors | Scheduled project and factory reviews that create bounded orders | Planned in [`workflow.md`](workflow.md) and [`build-order.md`](build-order.md) |
| Structured context reset | A durable handoff containing the plan revision, committed state, checks, findings and next action | Planned in [`workflow.md`](workflow.md) |
| Repository legibility | Project-owned conventions, bounded program design, observable worktrees and typed factory events | Mixed: the factory supplies the common evidence, the project supplies local structure |

The borrowing boundary is important. These sources validate the direction, but their harnesses are tuned to their own model, repository and deployment environment. Dim should take the separation of guides, sensors, evaluators, health loops and durable artifacts—not their prompts, thresholds or architecture rules.

The project boundary is part of that borrowing rule. Dim can standardize the order lifecycle and the evidence it records, while each repository supplies its own conventions, checks, architecture and vocabulary. Project maintenance and factory maintenance are separate loops: one creates orders to improve a project, while the other checks whether the factory's own workflow and evidence still support reliable work.

## OpenAI's agent manager pattern matches the operator boundary

The [OpenAI Agents SDK orchestration guide](https://openai.github.io/openai-agents-python/multi_agent/), read on 2026-09-22, names two ways to combine agents: a manager keeps control and calls specialists as tools, while a handoff transfers control to a specialist. It also describes code-directed orchestration for structured outputs, chained stages, evaluator loops and parallel independent work.

The factory is the durable, external-process version of the first pattern. The operator keeps control of the order and delegates bounded station work to planner, builder and reviewer workers; the reviewer can return findings, but the operator decides whether the outcome is acceptable and whether the order moves. The review loop therefore resembles the SDK's evaluator loop, while the worker boundary does not: each station is a separate harness session with its own attributed identity, assignment, audit events and worktree.

| OpenAI pattern | This repo's counterpart | Boundary |
|---|---|---|
| Manager agent retains control and invokes specialists | Operator delegates station work and approves plans, builds and reviews | The operator's control is durable and auditable rather than an in-process conversation state |
| Handoff makes a specialist the active agent | Assignment gives one worker a bounded station responsibility | The assignment does not transfer order authority; the operator remains the approver |
| Code-directed chain, evaluator loop and parallel agents | Plan → build → review, findings back to the builder, and later station fan-out | The factory persists each transition and attribution in the order record |

The borrowing stops at orchestration vocabulary. The SDK explains how agents can coordinate inside an application; it does not supply the factory's harness adapter, worker identity model, append-only audit trail or completion evidence. Those remain Dim's boundary and are documented in [`factory.md`](factory.md) and [`workflow.md`](workflow.md).

[Cloudflare's enterprise AI agent workspace](https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-agent-workspace/), read on 2026-09-22, covers the runtime around that manager: one durable workspace owns conversation state, tasks, schedules, consent decisions and an event queue; it selects isolated execution environments; and it saves outputs as durable work products. Cloudflare's [Agents documentation](https://developers.cloudflare.com/agents/) also gives each agent session a durable identity, storage, scheduling and recoverable execution, while [Workflows](https://developers.cloudflare.com/agents/harnesses/think/workflows/) is the durable multi-step layer for approval gates, long waits and retryable effects.

| Cloudflare pattern | This repo's counterpart | Boundary |
|---|---|---|
| Durable workspace with state, events and schedules | Factory order record, attempt ledger, trace stream and planned scheduler | Cloudflare makes the workspace the runtime authority; Dim makes the append-only order audit authoritative over external workers |
| Durable agent identity and recoverable execution | One attributed worker identity per harness session and a runner that will supervise it | The factory identity answers who acted; Cloudflare's identity primarily makes a hosted agent resumable and addressable |
| Isolated Dynamic Worker, Sandbox or browser execution | Per-order worktree and the future harness adapter | Cloudflare chooses a managed execution environment; Dim must launch local or user-selected harnesses without coupling the order model to one provider |
| Workflow approval gates, waits and retryable effects | Operator approvals, finding loop and scheduled factory work | The business gate is the same shape, but Dim records the approver and evidence as order facts |

Cloudflare is therefore useful prior art for the runtime we still need around the line: durable execution, explicit waiting, scheduling, isolation and trace export. It is not a replacement for the line design. Its workspace is the product surface; Dim's product is the attributed factory record that coordinates independent planner, builder and reviewer sessions.

## Headless harnesses converge on a semantic adapter boundary

The primary harnesses do not share one wire protocol: [Claude Code](https://code.claude.com/docs/en/cli-usage) and [Codex](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs) expose machine-readable JSON streams, [OpenCode](https://dev.opencode.ai/docs/cli/) exposes an ACP nd-JSON server as well as an HTTP server, [Grok Build](https://docs.x.ai/build/overview) exposes streaming JSON and ACP, and [Pi](https://pi.dev/docs/latest/rpc) exposes JSON event mode and JSON-RPC over stdin/stdout. [OMP](https://github.com/atyrode/omp) is a Pi-derived fork with its own CLI, RPC and ACP surfaces: it belongs to the same semantic contract, but gets its own adapter if the factory supports it rather than being treated as Pi by name.

| Shared semantic | Evidence across harnesses | Contract implication |
|---|---|---|
| Start in a working directory with a brief and model | All five provide a headless or protocol entry point with project/model context | The adapter receives a request, not a provider-shaped argv array |
| Stream progress | Claude and Codex stream lifecycle and item events; OpenCode, Grok and Pi expose protocol or streaming events | The runner consumes an async event stream and preserves raw provider data for diagnostics |
| Observe assistant output and tool work | Codex item events, Claude stream events, Pi tool events, and the protocol surfaces of OpenCode and Grok expose intermediate activity | Normalize message, tool, file and diagnostic events where a provider exposes them; absence is explicit rather than invented |
| Distinguish completion from failure | Codex has turn completion, turn failure and error events; Claude has structured print results; the other protocols expose terminal responses or events | The adapter returns a terminal result separately from process exit |
| Stop work | Every integration is a process or protocol session that the runner can close or cancel | Cancellation and timeout belong to the runner contract, not to one CLI's flags |
| Enforce permissions | Claude has allowed and disallowed tools; Codex has sandbox modes; OpenCode, Grok and Pi expose configurable tools, workspaces or protocol clients | The factory requests capabilities; each adapter validates and translates them, refusing unsupported grants |

The fake harness must implement this semantic contract, not imitate one provider's JSON. Provider adapters then get separate wire-fixture tests: the fake proves factory behavior for success, findings, crash, hang and bootstrap failure, while Claude, Codex, OpenCode, Grok and Pi fixtures prove that each adapter maps its own stream correctly. This is the boundary that keeps station orchestration, worker identity and audit records independent of the harness.

## HumanLayer makes the artifact lifecycle concrete

[HumanLayer](https://www.humanlayer.com/) makes research, designs, plans, worktrees, sessions and diffs part of one task rather than separate conversations. Its workflow separates investigation, decisions and code changes, and its design documents support comments and decisions that feed back into the agent before implementation. Its structure outlines divide work into vertical, testable phases, while later artifacts take precedence when feedback changes the result ([workflow phases](https://docs.humanlayer.com/explanation/workflow-phases), [artifact reference](https://docs.humanlayer.com/reference/skills-workflows)).

The useful comparison is not the product surface but the artifact rule:

| HumanLayer pattern | This repo's counterpart | Boundary |
|---|---|---|
| Versioned research, design and plan artifacts | Research, plan, program design and implementation outline | Dim keeps the local record and factory order as the source of truth |
| Comments and decisions attached to the artifact they affect | Findings, answers, holds and plan revisions | Dim records the decision as typed evidence rather than relying on document comments alone |
| Vertical structure phases with checks | Verified slices and per-slice review | The project still owns its conventions and checks |
| Context carried across sessions by task artifacts | Structured handoffs and durable order evidence | Dim also records the machine events that artifacts cannot reconstruct |

HumanLayer is the strongest precedent found for keeping the plan and its feedback close to the code without making the plan a second source of truth. The part to borrow is artifact locality and precedence; its hosted workspace, cloud synchronization and approval timing are adapter choices.

## StrongDM makes the loop concrete

[StrongDM's factory](https://factory.strongdm.ai/) gives the factory argument a more specific operating loop: a seed, an end-to-end validation harness, feedback from observed output, and repetition until holdout scenarios pass. It calls those end-to-end user stories *scenarios* rather than tests, and measures satisfaction empirically instead of treating a green test suite as the whole answer ([principles](https://factory.strongdm.ai/principles)).

[Dan Shapiro's account](https://www.danshapiro.com/blog/2026/02/you-dont-write-the-code/) sharpens the responsibility shift behind that model: once agents write and review the code, the human team's job becomes solving how the system knows whether the result works and is getting better. That reinforces Dim's factory-health loop and the decision to make observability, evaluation and maintenance first-class rather than treating them as reporting added after shipping.

The useful comparison is the boundary between the shared mechanism and the different product:

| StrongDM pattern | This repo's counterpart | Status here |
|---|---|---|
| Seed | A queue item routed through the line, with the repository's rules and declared check as its constraints | Live in [`factory.md`](factory.md) and [`build-order.md`](build-order.md) |
| Shift work | The operator passes an item and base revision; an isolated worker owns the line or station run | Live in [`factory.md`](factory.md) |
| Validation harness and feedback loop | Repo checks, read-only review, persisted findings, and the factory stop conditions | Live in the line and station contracts; the evidence is recorded in the session database |
| Holdout scenarios and satisfaction | Not the same as the current repository checks; this is application-level behavioral validation | Not adopted as a factory-wide contract |
| Digital Twin Universe | A possible application-specific test fixture, not a requirement of the session factory | Not adopted |
| Filesystem models and pyramid summaries | Local files, SQLite projections, and queries that retain a drill-down path from summary to source | Already the storage and recall shape |

The distinction matters. StrongDM treats generated code as opaque and replaces traditional review with behavioral validation ([techniques](https://factory.strongdm.ai/techniques)); this repo keeps source review and mechanical checks because its subject is the development process itself. The borrowed lesson is to make validation describe observed behavior and feed failures back into the next run, not to remove every human gate or to make code disposable.

## Symphony separates the two states this repo collapses

OpenAI's [Symphony](https://github.com/openai/symphony), read on 2026-09-19 at `be10a1b` — `SPEC.md`, the reference implementation under `elixir/`, the workflow prompt it runs on itself, and the agent-facing skills under `.codex/skills/` — is an orchestrator that dispatches a coding agent against issues in a tracker. It is the nearest published description of the execution model this repo arrived at, and it holds one distinction that is missing here.

Symphony keeps the tracker's state and its own claim state apart, and says so outright: "This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal claim state." An issue is `Unclaimed`, `Claimed`, `Running`, `RetryQueued` or `Released`, while a single attempt runs through `PreparingWorkspace`, `BuildingPrompt`, `LaunchingAgentProcess`, `InitializingSession`, `StreamingTurn`, `Finishing` and then one of `Succeeded`, `Failed`, `TimedOut`, `Stalled` or `CanceledByReconciliation`.

`factory_order.status` is both of those at once — `queued`, `working`, `completed` — which is why a failure here has to be modelled as the row going back to `queued`, and why an order whose worker died silently stays `working` with nothing able to say so.

| Symphony | This repo's counterpart | Status here |
|---|---|---|
| Claim reserves an issue "to prevent duplicate dispatch"; dispatch requires it is "not already in `running`" and "not already in `claimed`" | `dim order claim` refuses an order that is not `queued`, so the row is the reservation | Live, and the same shape |
| One workspace per issue, named from its identifier and "reused across runs for the same issue" | Worktree, branch and order id are one string ([`glossary.md`](glossary.md)) | Live, and arrived at independently |
| Workspace cleanup only "for terminal issues" | Nothing removes a worktree | `stop-removes-worktree` |
| Reconcile before dispatch: refresh tracker state for every running issue, cancel what is no longer routable | Nothing checks whether a `working` order's worker still exists | `session-end-stops-orders`, reached from the other side |
| `Stalled` when elapsed time passes `stall_timeout_ms`, distinct from `TimedOut` and `Failed` | One `failed` | Unbuilt; `wall-gaps` wants the same threshold for the board |
| Retry backoff bounded by `max_retry_backoff_ms` | A skill says to stop after one order fails twice | `stuck-slice-counter` — a rule a mechanism does not hold |

What does not transfer is the shape of the thing. Symphony is a service with a poll tick, in-memory runtime state and timers; this repo has no daemon, so a claim cannot live in memory and is a row instead — which is what makes it readable after the run rather than only during it. And Symphony's product is dispatch: it holds no evidence ledger, no gate an order must pass to be called done, and no independent review. The record is this repo's product, so the states worth borrowing are the ones that make an unattended run legible afterwards, not the ones that keep a service ticking.

The wider read settles where the borrowing stops. Symphony is "a scheduler/runner and tracker reader" (`SPEC.md:38`) and requires no version-control behavior at all (`SPEC.md:890`), so every act this repo gates — the commit, the check, the merge, the ticket transition — is performed by the agent inside its workspace, where the orchestrator cannot see it.

- **Nothing names the agent.** The required log fields are the issue and a `session_id` that is a Codex thread and turn (`SPEC.md:1363-1370`, `:315`); no record holds a model or an agent name, and there is no sub-agent concept. What attribution exists is prompt convention — a `Co-authored-by` trailer, a `[codex]` comment prefix (`.codex/skills/commit/SKILL.md:43`, `.codex/skills/land/SKILL.md:171`) — held by nothing. Nor is there a transcript: the debug API's session-log list is hardcoded empty (`elixir/lib/symphony_elixir_web/presenter.ex:83`) and its event history is the single last event (`:210-221`). This is the counter-example `event-actor` is argued against — a system whose whole account of a run is the worker's own testimony cannot answer who did what.
- **Done is what the tracker says, and the agent moves the tracker.** A clean worker exit means nothing (`SPEC.md:664`), the `completed` set is "bookkeeping only" (`:291`), and terminal tracker state is the whole condition (`:833-836`). The completion bar is prose in the workflow prompt (`elixir/WORKFLOW.md:265-273`) and nothing checks it ran; the pull-request body lint requires a checkbox to exist rather than to be ticked (`elixir/lib/mix/tasks/pr_body.check.ex:161-166`). A person moving the issue to `Merging` is the authorization.
- **Landing squashes.** `gh pr merge --squash` (`.codex/skills/land/SKILL.md:98`), so every commit the agent wrote is rewritten as it lands, while syncing is a merge and explicitly not a rebase (`.codex/skills/pull/SKILL.md:3-6`). The second half is what this repo already does; the first it cannot take, since `reachesTrunk` tests a recorded sha for ancestry and a squash makes every order fail its own completion gate.
- **Claims live in memory with no lease.** The claim set is a `MapSet` in one process (`elixir/lib/symphony_elixir/orchestrator.ex:39`), a restart drops every claim (`SPEC.md:1699-1701`), two processes against one tracker would double-dispatch, and nothing serializes two attempts against the same repo or branch — isolation is a full clone per issue and a merge at land time. The stall watchdog (`SPEC.md:823-828`) is a parent watching its child rather than a lease. A sixth claim state, `blocked`, exists in the implementation and not in the spec (`orchestrator.ex:40`, `elixir/README.md:33-36`), and clears on restart.
- **Worth taking: reconciliation as the stop.** Every tick re-reads the tracker for running issues and kills a worker whose issue left its routable state (`SPEC.md:833-838`). A hold that stops a running worker then needs no protocol, no signal handling and no cooperation from the agent: the row changes, and the next pass acts on it.

## What was not found is the instrument

Osmani's essay proposes no measurement. It closes on judgement: "The hard, skilled job is deciding where to put each switch." The governance writing sets its thresholds by policy — critical paths get a human, low-risk actions get auto-approval — and the threshold is asserted rather than derived.

This repo answers the same question from a record. [`goals.md`](goals.md) states what the factory is measured against, [`findings.md`](findings.md) is what the corpus said when asked, [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether a rule earns its place, and [`loop.md`](loop.md) is how one gets cut. A finding like *a rule can be missing rather than ignored* — a convention that never reached the tool that was breaking it — is not reachable from an essay, because it requires the transcripts.

No surveyed project makes that join. The people arguing the position are not instrumenting it, and the people instrumenting sessions are not arguing a position — [claude-gates](#a-gate-that-reads-a-record-of-past-failures) comes closest and reads a log it writes itself rather than the sessions.

The missing precedent is therefore a composition rather than a missing feature: a project-aware workflow, a durable event record with attribution, queryable evidence, scheduled maintenance for both projects and the factory, and a wall that lets a person follow an order from its plan through its changes, findings and holds. The surveyed systems reach one or two of these surfaces, but none joins them into one local operating record.

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
| Acolyte, this machine's own | A command contract, so each `dim` subcommand carries its own help | `acolyte/src/cli-contract.ts` is fifteen lines: a command is a handler plus a `help()` returning its own usage, and `cli-help.ts` prints the table rather than a written-out block. This repo already does that for queries — a `Query` carries `name`, `summary` and `usage`, and `q list` prints from the registry — while `src/cli.ts` keeps a hand-maintained usage string beside a switch. Take the contract and not the presentation: that CLI is read by a person who can try `--help`, read a README, or guess, and this one is read by an agent that takes the printed surface as the whole surface. A flag missing from the listing does not exist to it, which is what happened on 2026-09-18 when a query shipped with no `usage` and `q list` stopped offering an argument the README documents. So no banner, no examples block, no i18n — each costs tokens on every call and answers a question only a person asks. What is refused outright is most of that CLI: auth, oauth, credentials, cloud and daemon are out by the invariant at the top of [`src/cli.ts`](../src/cli.ts), and its `printError` is superseded by `src/warn.ts` and the lint rule behind it. Extends the borrow [`design.md`](design.md) already records. |
| [Superpowers](https://github.com/obra/superpowers) | A stuck-slice counter, and re-stating a station's brief after compaction | The nearest prior art the stations have, and it predates them: its workflow skills hand off between deciding, building under test and proving done, which is the shape of `dim-line-feat`, `dim-line-fix`, `dim-station-build` and `dim-station-review`. What it keeps is design docs and worktrees, so it can answer what this change is for and not what the machine already did — and its own docs record the hole, that a session-start bootstrap is lost after compaction where the harness has no post-compaction hook. That is this repo's premise, written by the author of the thing it answers. Read on 2026-09-17 from its README and docs rather than its source. |

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
| [Ferment](https://docs.kimchi.dev/docs/coding-ferment) | A letter grade from the judging agent | Its judge grades each step A-F and a low grade can block the next phase, with no stated threshold. A grade cannot be earned the way a reviewer here earns trust — plant a defect, watch it be caught, take it out — and a cutoff no test can prove is the hardcoded nudge [`AGENTS.md`](../AGENTS.md) warns about. A finding is present or absent, which keeps it falsifiable. Read on 2026-09-17 from its docs rather than its source. |

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
