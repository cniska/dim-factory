# The landscape

The owner's survey of what else exists, run 2026-09-17–22 over public projects and writing, and what each source contributed to the factory's design: taken, shaped by, or refused with the reason, so a later survey does not raise it again. A web survey sees only what is published, so a team running the same idea on an internal corpus is invisible to it.

What the survey found overall: the argument for a factory with human-held gates is widely made, and session collectors are a crowded field, but no project joins the two — a gate whose rule is decided by evidence read from a session record. That join is what this repo builds.

## The factory argument

- **[Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/)** draws the distinction the factory draws: dark ships code no human read; light keeps human judgement and moves it upstream. *Contributed:* the position that each gate earns its automation on its own merit, stated in [`factory.md`](factory.md). Its [agent-skills](https://github.com/addyosmani/agent-skills) set drew the line between a portable skill and a station that reads the record, which is why the `dim-station-*` skills live here.
- **[Harness engineering](https://martinfowler.com/articles/harness-engineering.html)** separates feed-forward guides from feedback sensors, and fast computational sensors from expensive inferential ones. *Contributed:* the split between the rules and plan a worker is given, the checks and gates that run on every change, and the review dimensions aimed where they add confidence.
- **[OpenAI's harness engineering with Codex](https://openai.com/index/harness-engineering/)** treats the repository as the system of record, enforces architecture with structural tests, and has agents review agent work. *Contributed:* the quality floor, and the scheduled maintenance orders in [`build-order.md`](build-order.md).
- **[Anthropic's long-running harness](https://www.anthropic.com/engineering/harness-design-long-running-apps)** passes structured artifacts between sessions and separates the generator from the evaluator, whose criteria must be concrete. *Contributed:* the Plan, Build and Review artifacts, the independent reviewer, and review against a fixed brief.
- **[StrongDM's factory](https://factory.strongdm.ai/)** runs a seed through a validation harness and feeds observed output back until holdout scenarios pass; [Dan Shapiro](https://www.danshapiro.com/blog/2026/02/you-dont-write-the-code/) adds that once agents write the code, the team's job is knowing whether it works. *Contributed:* observability and factory health as first-class work. *Refused:* replacing source review with behavioral scenarios, since this repo's subject is the development process.

## Orchestration and runtime

- **[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/)** distinguishes a manager that keeps control and calls specialists from a handoff that transfers control. *Contributed:* the operator as a manager that never hands over the order; each station worker is a separate session with its own identity.
- **[Symphony](https://github.com/openai/symphony)**, read at `be10a1b`, dispatches a coding agent against tracker issues. It keeps its own claim state apart from the tracker's, gives each attempt its own states (`Stalled` and `TimedOut` apart from `Failed`), and stops a worker by re-reading the tracker each pass. *Shapes:* the order lifecycle design, since `factory_order.status` holds order and claim state at once, and the stop as reconciliation. *Refused:* claims held in memory, where a claim here is a row readable after the run, and landing by squash, which rewrites the shas completion checks.
- **[Cloudflare's agent workspace](https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-agent-workspace/)** makes one hosted workspace the authority for state, schedules and isolated execution. *Contributed:* prior art for durable execution and scheduling. *Refused:* a hosted workspace as the authority; the local order record is.
- **Headless harnesses** — [Claude Code](https://code.claude.com/docs/en/cli-usage), [Codex](https://github.com/openai/codex), [OpenCode](https://dev.opencode.ai/docs/cli/), [Grok Build](https://docs.x.ai/build/overview), [Pi](https://pi.dev/docs/latest/rpc) — share no wire protocol but the same semantics: start with a brief in a directory, stream events, report completion apart from process exit, cancel, and grant permissions. *Contributed:* the harness adapter boundary, where the factory requests capabilities and each adapter translates them, and a fake harness that implements the semantics rather than one provider's stream.
- **[HumanLayer](https://www.humanlayer.com/)** keeps research, designs and plans versioned beside the task, with feedback attached to the artifact it affects. *Contributed:* artifacts held in the order record, with approval and return as typed events. *Refused:* its hosted workspace as the authority.

## Session records and gates

- **Collectors** — [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search), [agentsview](https://github.com/BUKOWSKIREAL/agentsview), [claudex](https://github.com/utensils/claudex), [flightlog](https://github.com/RobHudson72/flightlog), [code-session-memory](https://github.com/djannot/code-session-memory), [claude-code-analytics](https://github.com/spences10/claude-code-analytics) — read session files into a local index. None installs a rule that holds. *Contributed:* `PostToolUse` as an installed event (claude-code-analytics). *To take:* CASS's reciprocal-rank fusion over a word score and a meaning score (`rank-fusion` in [`build-order.md`](build-order.md)). *Refused:* a watching daemon (flightlog; `dim sync` closes the lag on demand), parsers for many CLIs (claudex; two tools in depth is a goal), remote embeddings and vector databases (no network, no credential), dashboards and derived cost (agentsview), chunking below a section and a resumable indexer (neither pays at this corpus's size).
- **Recall.** Every collector is pull-only: a CLI a person runs or a tool an agent must be taught to call. *Contributed:* `dim wake` on `SessionStart`, the channel that arrives without being asked ([`recall.md`](recall.md)).
- **[claude-gates](https://github.com/DevRik99/claude-gates)** is the nearest gate: one of its gates blocks work until a registered defect class is closed. *Refused:* its reading of a log a person appends by hand, and deciding judgement calls by pattern; here a judgement goes to an agent with a fixed brief and a gate holds only shapes.
- **[Ferment](https://docs.kimchi.dev/docs/coding-ferment)** grades each step A–F. *Refused:* a grade has no threshold a test can prove; a finding is present or absent.

## Evidence the premise holds

- **[Gas Town](https://github.com/gastownhall/gastown)** has an agent ask a predecessor what it decided rather than re-read the code, the premise of `dim q resume` reached independently. *Refused:* batch bisection (slices are serial), watchdog tiers (a gate refuses rather than a witness nudging), and its private vocabulary.
- **[agent-working-memory](https://github.com/CompleteIdeas/agent-working-memory)** answers an empty recall by abstaining with the withheld count, this repo's rule that a query with nothing to report says so. *Refused:* scheduled decay; a record of what happened does not forget.

## Planning

- **[Superpowers](https://github.com/obra/superpowers)**, read at v6.4.1, asks which inputs or failure modes a spec implies that no task's test exercises. *Contributed:* that question in the plan reviewer's brief in `dim-station-plan`.

## The owner's own projects

- **[Acolyte](https://github.com/cniska/acolyte)**, the owner's coding agent, is the prior art the factory was built from. *Contributed:*
  - the runtime and storage shape: Bun and TypeScript over `bun:sqlite` in WAL mode with typed prepared statements, a close that checkpoints, and a data directory read from an injected environment so a test can point a whole run elsewhere ([`design.md`](design.md));
  - its transcript import's per-source parsers over one normalized shape, and the `stale` measure of how far a session's files have moved since ([`design.md`](design.md));
  - embeddings stored as a blob beside the rows and scored by a cosine over `Float32Array` views, with no vector store, and its memory benchmark's recall and nDCG metrics ([`recall.md`](recall.md));
  - the workspace contract and its `$FILES` placeholder ([`recall.md`](recall.md)), and the rule that an agent never changes the user's repository as a side effect of running ([`worktrees.md`](worktrees.md));
  - the command contract, where each CLI command carries its usage with its handler: the `Command` in [`src/command.ts`](../src/command.ts), without the human-readable output;
  - `unreachable(value: never)` for exhaustive switches over a closed vocabulary (`closed-vocabularies` in [`build-order.md`](build-order.md)).