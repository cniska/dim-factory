# dim-factory Specification

> A software factory run by coding agents, with the owner at the gates that still earn one.

This document states what must hold, not how. [`docs/`](docs/) explains how each part works and why, and [`docs/glossary.md`](docs/glossary.md) defines its words.

## 1. Orders

- **FR-1** — The factory does every step that needs no judgement itself: preparing an order's workspace, moving the order between stations, checking the builder's commits, rebasing, shipping and cleaning up. Every step that needs judgement is decided by the owner or a worker, never by the factory. No pattern, word list, threshold or other rule of thumb stands in for a judgement.
- **FR-2** — An order is added with a title, a description and a project, and waits until the operator runs it.
- **FR-3** — A project is named `owner/repo` after its checkout's `origin` remote. An order added from a checkout belongs to that checkout's project unless another project is named.
- **FR-4** — A project's settings, committed in the project, tell the factory how to work on it, and a user's settings do the same for that user. A project's setting overrides the same setting of the user's, and a setting the factory does not know is refused.
- **FR-5** — The factory hardcodes nothing that differs from one project to the next, such as how a project ships: each such difference is a setting, added when the first project that needs it is adopted.
- **FR-6** — Each order is built in its own workspace and branch, so several orders can be built at once.
- **FR-7** — Before a station works in an order's workspace, the factory installs the project's dependencies there with the package manager its committed lockfile names, matching the lockfile exactly. A project with no lockfile gets no install.
- **FR-8** — An install that fails stops the run before any station works, with a refusal naming the install command and what it printed.
- **FR-9** — The install runs none of the project's lifecycle scripts.
- **FR-10** — The install, the check and each station's worker run the tool versions the project's checkout pins.
- **FR-11** — A pinned toolchain the factory cannot resolve stops the run before any station works, with a refusal naming the cause.
- **FR-12** — A running order goes through the plan, build and review stations in that order, and then ships.
- **FR-13** — At each station, one worker is briefed, does the station's work and returns its artifact.
- **FR-14** — The owner approves or returns each artifact, and the operator carries out that decision. Approval runs the next station. A return runs the same station again, and its worker revises the artifact.
- **FR-15** — A builder or reviewer that finds a problem in the previous station's work returns the order to that station, never further back, and the problem goes into that station's next brief. A planner that cannot plan the order as written says why, and the order goes back to the operator, who updates it and runs it again, or cancels it.
- **FR-16** — The operator can update an order's title or description until its plan is approved, except while a station is working on it, and the next run plans the order again from the update. Once the plan is approved, an update is refused, unless the planner has returned the order to the operator.
- **FR-17** — When a station finishes, the operator's command that started it returns with the outcome, and the record shows it.
- **FR-18** — The operator never chooses a station. Running an order does whatever its record says comes next, and an approval, a return or a worker's return each runs the station it leads to.
- **FR-19** — Once the Review artifact is approved, the factory ships the order without being asked: its commits land on the project's default branch.
- **FR-20** — Shipped commits sit on top of the default branch as it is and pass the project's check there. When the default branch has moved on, the factory rebases the order onto it by itself. Only a conflict or a failing check sends the order back to build.
- **FR-21** — The commits that land on the default branch are signed as the owner's git config says, since a landing follows the owner's approval. A landing that cannot sign them stops with its cause and lands nothing.
- **FR-22** — Ships run one at a time.
- **FR-23** — A ship that is interrupted leaves the default branch with all of the order's commits or none of them, and the order either shipped or ready to ship again.
- **FR-24** — An order whose changes reached the default branch is recorded as shipped, even if its workspace and branch could not be removed.

## 2. What can happen when

- **FR-25** — Which actions an order admits, and which of them moves it on, are worked out from its record alone.
- **FR-26** — An action the order does not admit is refused, the refusal names the actions it admits, and the record is left unchanged.
- **FR-27** — Nothing more can happen to a shipped or cancelled order beyond reading it.
- **FR-28** — While a station is working on an order and its worker is still running, or while the order is shipping, no other station run, approval, return or ship is allowed on that order.
- **FR-29** — An order can be cancelled at any point until it ships, except while its ship is running. Cancelling stops any station working on it, removes its workspace and its branch, and ends the order.
- **FR-30** — A station or ship that fails leaves the order where its record puts it, and the operator is told why. Running the order again, once any cause outside the order is cleared, continues from there.

## 3. Stations

- **FR-31** — A station worker starts with its station's instructions in its system prompt, and loads no skill to find them. A brief is a fixed set of fields — the order's facts and where the station stands — and briefs, messages and command output carry facts, never instructions.
- **FR-32** — Each station works from what the station before it produced: the planner from the order's description, the builder from the approved plan, the reviewer from the approved Build artifact and the order's diff.
- **FR-33** — What differs from one order or turn to the next goes in the brief; what is the same for every order goes in the station's instructions; what a worker may or may not do is enforced by how the factory starts it, never asked of it in words.
- **FR-34** — The factory ships every instruction its workers and its operator follow and depends on no skill of the owner's own.
- **FR-35** — The planner returns the plan: prose the owner can read, and the slices the builder builds in order. Each slice has a title and its outcome.
- **FR-36** — Nothing the planner writes becomes the order's work. The plan is recorded from what it returns.
- **FR-37** — The builder reads the approved plan, then writes, verifies and commits each slice in order until every slice is done. A slice's commit is kept on the order's branch only when it passes the gates.
- **FR-38** — A slice that is not kept leaves the order's branch as it was.
- **FR-39** — A slice gate exists only for what reading the change cannot show: that nothing judging the work was changed, and that the commit sits on the order's branch where the record expects it. A commit that fails a slice gate is taken off the branch. Everything reading the change can show is left to review.
- **FR-40** — The builder simplifies each slice before committing it, so the code it ships works without known bugs and stays easy to maintain.
- **FR-41** — Each slice's commit carries its subject line. The finished build returns an answer to each review finding it was given, and the Build artifact, which explains what was built so the owner can read it instead of the diff.
- **FR-42** — Every commit a worker or the factory makes carries the owner's git identity as its author and committer. A worker's commits are not signed.
- **FR-43** — A builder's commit runs the project's own git hooks, as a commit in a worktree of the project's checkout would, inside the builder's sandbox.
- **FR-44** — The reviewer reads the Build artifact and the order's whole diff, and nothing it writes becomes the order's work. It returns either its findings, each naming its area, file and line, what is wrong, the fix and how serious it is, or the Review artifact, which says whether the diff does what the Build artifact says, which areas it covered, and what it set aside or could not verify.
- **FR-45** — Review covers whether the diff does what the Build artifact says, correctness, tests, architecture, maintainability, docs, security, performance and style.
- **FR-46** — Review findings send the order back to build. There the builder answers each finding once, `fixed` or `refused`, and commits its fixes through the same gates as a slice. The next review is briefed with those answers. A Review artifact waits for the owner's approval.
- **FR-47** — When the builder returns an order to plan, slices already committed stay on the order's branch, and the revised plan says which of them stay, change or go.
- **FR-48** — Each station hands over only when its definition of done holds, which the factory checks: the plan is done when it has come back in its shape; the build when every slice of the approved plan is committed through the gates, the branch holds no commit and the workspace no change that the gates have not taken, every finding it was given is answered, and the Build artifact is back; the review when the Review artifact is back with no open finding. Its artifact then waits for approval. A return that leaves the definition of done unmet records nothing and goes back to the same worker with what was missing; if its corrected return misses it too, the station fails and the operator decides.

## 4. Workers

Every agent in the factory is a worker: the operator, and each station's worker — the planner, the builder and the reviewer. A worker is a lasting identity and the context the record holds for it; a session is the harness process that currently carries that context, and can be replaced.

- **FR-49** — Only the operator adds, runs, updates or cancels an order, or approves or returns its artifact.
- **FR-50** — A project has one operator, a worker like any other. Each new operator session is that worker's next session, and carries on with every order of the project and every reply its station workers send.
- **FR-51** — The operator never does a station's work.
- **FR-52** — The owner works with the factory only through the operator.
- **FR-53** — The operator can message a station's worker on an order. The message runs a turn of that worker's session that only reads, and the reply goes only to the operator.
- **FR-54** — No other messaging exists: a message from a station's worker to anyone but the operator is refused.
- **FR-55** — Every message between the operator and a station's worker, including refused ones, is recorded under its sender, with its recipient and its order.
- **FR-56** — Each station of an order keeps one worker, with one name, for the order's whole life. Every turn at that station resumes the worker's current session, including the turn after a failed one.
- **FR-57** — A worker's session has died when resuming it fails or its harness cannot run it, whatever the reason. The factory then starts a new session for the same worker on the station's next run and records why the old one died.
- **FR-58** — Nothing a station needs in order to continue lives only inside a session. The record and the order's workspace hold all of it: the order, its artifacts, the decisions and their reasons, the messages, the commits and the worker's earlier sessions, each readable in full — everything it was sent and everything it did. A new session starts with exactly the context its worker's dead session held when it died — the same messages, tool calls and results, in the same order — and carries on where the old one stopped, with nothing lost.
- **FR-59** — A worker acts only through a session it owns: the operator through a harness session in the project's checkout, registered by the first operator action it takes; a station's worker, which the operator creates for one role on one order, through a session the factory starts for it.
- **FR-60** — Every worker is recorded with a generated name that no other worker has, one word and a number, and with its role; a station's worker also records the operator that created it. Each of its sessions is recorded, linked to it, with its harness and its process, so what the worker did on an order can be read afterwards.
- **FR-61** — A worker's turn is over once its process has ended, and nothing needs to keep running to notice.
- **FR-62** — Each station's worker runs on the model the user's settings name for its role, or on the settings' default model when they name none for it. No model name is fixed in the factory.
- **FR-63** — The factory decides who a `dim` command acts as from the process that runs it. Nothing a worker can read, set or start lets it act as someone else.
- **FR-64** — A station's worker and a check start with only a listed set of environment variables, never the owner's environment. The check gets no credentials. A station's worker gets only the sign-in its own harness needs, and nothing another worker left behind outside the workspace.
- **FR-65** — A check writes only inside the tree it checks and its own temporary directory.
- **FR-66** — A station's worker cannot change the factory it runs under — its code, instructions, gates, hooks, settings or record. It reaches the record only through what its station accepts from it.
- **FR-67** — A change an order makes to a gate, instruction, check or setting takes effect only after the order ships.

## 5. Instructions

- **FR-68** — The owner invokes only `dim-factory`, in the operator's session; it is the one skill the factory installs.
- **FR-69** — `dim-factory` turns what the owner asks for into one order with a title, a description and a project.
- **FR-70** — `dim-factory` holds the operator's instructions: running orders, judging each artifact against the record, and carrying out the owner's decisions.
- **FR-71** — The planner's instructions: find what was already built and decided, find a bug's cause before planning its fix, and cut slices that each verify on their own.
- **FR-72** — The builder's instructions: write, verify, simplify and commit each slice through the gates, writing a bug fix's failing test first.
- **FR-73** — The reviewer's instructions: read the Build artifact and the whole diff area by area, taking what the gates proved as done, and check that a bug fix repairs the cause rather than a symptom and that its tests catch the bug.
- **FR-74** — The planner's, builder's and reviewer's instructions share one reference on how every artifact is written for the owner: the outcome first, drawn from the record.
- **FR-75** — The builder's instructions hold the red, green, refactor method for a slice that changes behavior.
- **FR-76** — The builder's instructions hold the simplification pass, which changes no behavior and no test.
- **FR-77** — The builder's instructions hold the git rules the builder follows, such as commit subjects and who owns a workspace.
- **FR-78** — `dim-factory` holds, in a reference it reads when the owner asks for an audit, a read-only sweep of a project's code whose findings become orders.
- **FR-79** — `dim-factory` holds, in a reference it reads when the owner asks for it, how the standing instructions agents load are added, sharpened or removed.
- **FR-80** — `dim-factory` is installed for the user, linked to the checkout `dim` runs from, so the factory runs in any project; what the factory adds to a project is its gates, what wires them in, and its settings, nothing else.
- **FR-81** — A project's own skills live in its `.agents/skills` and serve work on that project; the factory never installs them for the user.
- **NF-1** — Each set of instructions holds only what its job needs and states each instruction once across all of them, sharing one reference where several need the same instruction, and is kept only while the orders that use it show it improves their results.

## 6. Record

- **FR-82** — Every action on an order, and every change the factory makes to it, names who did it: a worker and the session behind it, or the factory itself, with the version of the factory that did it and the action that caused it. Nothing is unattributed.
- **FR-83** — A recorded action is never changed or removed.
- **FR-84** — An action is attributed when it is recorded, from the session that took it. Nothing attributes an action afterwards, and an action whose session the factory cannot establish — such as one from a process a running station started before its worker's session existed — is refused, not recorded.
- **FR-85** — Every decision on an order — an approval, a return, a worker's return, a cancellation, a refused finding — records who decided it and why. An approval or return records the owner, or the operator where the owner has handed it that decision; a worker's own decision, such as its return or a refused finding, records that worker. Every stop — a failed station, a refused slice, a stopped ship, a session that died — records its cause as a code with its details.
- **FR-86** — Each order has one log, and it holds every action that touched the order, whoever took it — a worker's session or the factory — and nothing that did not. Evidence, such as a check's output, is attached to the action that produced it.
- **FR-87** — The factory keeps a trace of its own steps for diagnosing the factory, apart from the order logs. Nothing in an order's log depends on it, it can be followed live for one order, and it can be thrown away.
- **FR-88** — How the factory performs is measured by queries over the order logs and the session record, with no separate telemetry stream.
- **FR-89** — A station worker's session is in the session record, attributed to its worker, as any Claude session is, and so are its subagents' sessions, attributed through it.
- **FR-90** — A worker's work reaches the record only while its turn is open, and each piece of it, a slice's commit or a station's return, is recorded whole or not at all.

## 7. The wall

- **FR-91** — The wall shows the owner every order across all projects on one board, each with its title, project, station and worker, in one column per order status: queued, running and shipped. A cancelled order leaves the board. It changes nothing.
- **FR-92** — Opening an order on the wall shows that order alone: its facts, its plan, Build and Review artifacts as documents the owner reads in place of the diff and the sessions, the model calls and tokens each station's worker and its subagents used with what the tokens were read for, and its log in order.
- **FR-93** — The board and an open order follow the record as it changes, without a reload, and the wall says so when it cannot read the record rather than showing what it last read as current.
- **FR-94** — The wall has a development mode in which a change to the wall's own code reloads the open page by itself.
- **NF-2** — Only the owner's own browser page can read the wall. Another website, or a web address pointed at this machine, reads nothing.
- **NF-3** — Showing a worker's artifact on the wall loads nothing the worker linked to.

## 8. Reliability, hooks and reads

- **NF-4** — Any factory process — a worker, a station, a ship, the operator — can be killed at any point and the record stays consistent. The next time the order runs, the factory repairs by itself everything whose repair needs no judgement: it gives a worker whose session died a new one, takes a slice commit the record does not hold off the branch while leaving its changes in the workspace, closes an abandoned review round, and finishes or rolls back an interrupted ship. Anything else it finds, it reports to the operator with its cause.
- **NF-5** — Every `dim` command's output is written for an agent to read: one structured result per command. A refusal carries its code, its cause and the action that resolves it. The wall is the only thing written for the owner to read.
- **NF-6** — Every `dim` command is one whole word naming a thing, with subcommands for what to do to it, such as `dim hooks install`, `dim order approve` and `dim query search`. A command whose word already says what it does stands alone, such as `dim doctor` or `dim sync`.
- **NF-7** — A hook a coding-agent session runs never fails the session, whatever happens.
- **NF-8** — A git hook `dim` installs blocks a commit or push only when it has read and understood what it refuses. Anything it cannot read, it lets through.
- **NF-9** — Reading the record cannot change it: a query, `dim sql` and the wall fail on any write instead of making it.
- **NF-10** — A reader refuses a record written by another version of the factory before reading anything from it. `dim doctor` is the exception: it reports the mismatch and how to fix it.
- **NF-11** — No hook runs a command from a station worker's workspace outside that worker's sandbox.
- **NF-12** — A station's worker that changes the hooks or the config git uses in the project's checkout fails its station, with the change undone.

## 9. Adopted projects

- **FR-95** — The factory keeps one canonical set of gates, the ones dim-factory runs on itself: the commit-subject rule on every commit and on every pushed commit, the project's check before a commit and on every push, and the comment ban over every tracked file it reads, before a commit and on every push. Each runs in the project without `dim`.
- **FR-96** — Adopting a project chooses which canonical gates it installs and commits the choice as a project setting. Installing writes each chosen gate into the checkout, where the project commits and owns it, and removes a gate no longer chosen. A gate the project cannot run, such as the comment ban in a project with no code it reads, is refused when chosen. A part of a gate that serves one language is installed only while the project uses that language, which `dim` finds from the project's tracked files without being told.
- **FR-97** — Installing the gates is idempotent: a gate that matches the canonical one is left as it is, and one that has fallen behind is replaced whole. Installing with no choice made is refused, except that a person at a terminal is asked to choose. A project extends a gate with a file of its own beside it, such as a step of its own before a commit, never by editing the installed one.
- **FR-98** — `dim doctor` changes nothing. Run in a project's checkout, it reports each thing the factory needs of the machine and of that project that does not hold, with what resolves it: no gates chosen, a chosen gate missing, behind the canonical set or changed in place, and a gate present but not chosen among them.
- **FR-99** — A project's check is the declared task its settings name, or the task named `check` where they name none, and its format command likewise with `format`. Adopting a project records the names its own tasks already have rather than renaming them.
- **FR-100** — A build hands over only once the project's check, run on its branch's head after its definition of done holds, passes without changing the workspace. A check that fails or changes the workspace is recorded with its output and keeps the build with its builder, and is not a missed return.
- **FR-101** — Every station's worker can run whatever verifies a claim, and the programs it runs may write in its workspace and its temporary directory. Only the builder edits the project's files itself.
- **FR-102** — Only the builder's commits taken through the gates become the order's work. Every other turn ends with the workspace back at the order's recorded head, keeping only the files the project's git ignores.
- **FR-103** — The planner can search the web and read web pages.
- **FR-104** — A station's worker is offered only the tools station work uses: the shell, reading, writing and editing files, and starting subagents, with the planner's web tools beside them.

## 10. Acceptance criteria

- **AC-1** — An order added, run, planned, built, reviewed and approved at each station lands on the default branch and is recorded as shipped. (FR-2, FR-12, FR-13, FR-14, FR-19)
- **AC-2** — An order runs from its first station to shipped with the operator's only actions being running it once and approving or returning artifacts, including when review findings send it back to build. (FR-1, FR-46)
- **AC-3** — An order added in a checkout whose `origin` remote is `github.com:acme/widgets` belongs to `acme/widgets`. An order added anywhere else is refused unless it names its project. (FR-3)
- **AC-4** — Two orders are built at once, each in its own workspace and branch, and their ships do not overlap. (FR-6, FR-22)
- **AC-5** — A returned artifact comes back revised by the same station's worker. A builder or reviewer that returns the order to the previous station puts it there, with the problem in that station's next brief. (FR-14, FR-15, FR-56)
- **AC-6** — A builder's return naming a problem in the plan puts the order back at plan, with the problem in the planner's brief. A planner's return saying the order cannot be planned puts it back with the operator. (FR-15)
- **AC-7** — The command that started a station returns when the station finishes. Approving runs the next station, returning reruns the same one, and no operator command takes a station name. (FR-17, FR-18)
- **AC-8** — Approving the Review artifact lands the order with no other command. After the default branch moves on, an order that applies cleanly and passes the check there lands, and a conflict or a failing check leaves it at build. An order one of whose slices already reached the default branch still ships, one commit per slice. (FR-19, FR-20)
- **AC-9** — A conflict found while shipping puts the order at build, and the build's resolution passes the slice gates before the ship lands it. (FR-20, FR-37)
- **AC-10** — A ship killed after the order's commits reached the default branch leaves every commit of the order landed and the order recorded as shipped. One killed before that leaves none landed and the order ready to ship again. (FR-23)
- **AC-11** — A ship stopped because the default branch's checkout has uncommitted changes is reported to the operator, and running the order again lands it once the checkout is clean. (FR-30, NF-4)
- **AC-12** — Shipping an order whose workspace cannot be removed lands its commits, records it as shipped, and names the kept workspace and branch with the reasons. (FR-24)
- **AC-13** — For every state an order can be in and every action, the action is allowed exactly when the order admits it. Each refused action names the actions the order admits and leaves the record unchanged, and a shipped or cancelled order refuses them all. (FR-25, FR-26, FR-27)
- **AC-14** — While a station works on an order, or the order ships, a second station run, an approval, a return and a ship are each refused. Once the station's worker process has ended, they are allowed again. (FR-28, FR-61)
- **AC-15** — Cancelling an order in the middle of a build stops its builder, records nothing of the unfinished turn, removes its workspace and its branch, and leaves the order cancelled. A cancel the checkout cannot carry out is refused and leaves the order as it was. (FR-29, FR-90)
- **AC-16** — After a failed station run, running the order again resumes the same worker from where the record puts the order. (FR-30, FR-56)
- **AC-17** — Each station worker starts with its station's instructions in its system prompt, the plan, build and review briefs contain no instructions, and each recorded slice of a plan has a title and an outcome. (FR-31, FR-35)
- **AC-18** — Each station worker's system prompt holds its station's instructions and every reference they use, `dim-factory` holds the operator's instructions and adds orders, and an instruction several sets share is one reference rather than repeated in them. (FR-68, FR-69, FR-70, FR-71, FR-72, FR-73, FR-74, FR-75, FR-76, FR-77, FR-78, FR-79)
- **AC-19** — A review of all shipped instructions finds no instruction stated in two of them and none that the record of orders using it shows adding nothing. (NF-1)
- **AC-20** — After installing the factory, a project with no factory files runs an order to shipped, `dim-factory` is the only skill installed for the user, and dim-factory's own `.agents/skills` appear in no user skill directory. (FR-80, FR-81)
- **AC-21** — Every `dim` command is one whole word, each with more than one action takes its action as a subcommand, and no command name joins two words with a hyphen or shortens a word. (NF-6)
- **AC-22** — A slice with a comment, an unchanged test, an unusual subject line or a failing check is kept, while a slice that changed the check's definition, or whose commit is not on the recorded head of the order's branch, is refused. (FR-39)
- **AC-23** — The planner's brief holds the description, the builder's the approved plan, and the reviewer's the approved Build artifact and the diff; no brief holds a sentence that every order's brief would repeat, and no brief or instruction asks a worker not to do what the factory already prevents. The builder's brief names the project's check as the gates run it. (FR-31, FR-32, FR-33)
- **AC-24** — With a first operator session gone, the operator's next session in the project runs its orders and receives its station workers' replies as the same worker, and a second live operator session in one project is refused. (FR-50)
- **AC-25** — A builder that returns an order to plan after two committed slices leaves both on the branch, and the revised plan's next build keeps, changes or removes them as the plan says. (FR-47)
- **AC-26** — A planner's return saying the order cannot be planned lets the operator update the order and run it again, and the next plan is briefed with the updated description. An update to a queued order or to a plan awaiting approval is accepted and the next run plans again; an update after the plan is approved is refused, except once the planner has returned the order. (FR-15, FR-16, FR-49)
- **AC-27** — Every instruction a station worker or the operator follows ships with the factory, and a machine with no personal skills installed runs an order to shipped. (FR-31, FR-34)
- **AC-28** — A planner's attempt to write to the record is refused, and its plan appears in the record only from what it returns. It still reads the record through its turn. (FR-36, FR-66)
- **AC-29** — A plan with no slice, a slice commit with no subject line, and a review finding with no file each record nothing and go back to the same worker with what was wrong; a corrected return is accepted, and a second refused return fails the station for the operator. (FR-35, FR-41, FR-44, FR-48)
- **AC-30** — One build of a plan with several slices commits each slice in order through the gates and returns once, with the Build artifact. (FR-37, FR-41)
- **AC-31** — A slice that changes the check's definition is refused with the order's branch left as it was, and the order's log holds the refusal naming the refused commit. (FR-37, FR-38, FR-86)
- **AC-32** — Code more complex than its outcome needs comes back from review as a maintainability finding, and every Review artifact reports which areas it covered. (FR-40, FR-45)
- **AC-33** — A reviewer's attempt to write to the record is refused. Its findings put the order at build in the same run, where a turn that leaves a finding unanswered or answers one twice is refused, and its fixes pass the slice gates. (FR-44, FR-46)
- **AC-34** — A worker that is not the operator is refused each operator action, and the order and its record are left unchanged. (FR-26, FR-49)
- **AC-35** — The operator's attempt to record a plan, a commit or a finding itself is refused. (FR-51)
- **AC-36** — An owner's `dim order` action from a session that is not the operator's is refused. (FR-52)
- **AC-37** — The operator's message runs a turn of the named station worker's session, and the reply goes only to the operator, both recorded with sender and recipient. That turn only reads: its worker's writes to the workspace and its slice submits are refused. A station worker's message to another station's worker or to the owner is refused and recorded as refused. (FR-52, FR-53, FR-54, FR-55)
- **AC-38** — A builder whose session hit a usage limit, and one whose session is gone, each get a new session on the next run, under the same worker name and with the cause recorded. The new session starts holding the same messages, tool calls and results as the dead one held when it died, it carries on from where the old one stopped — committed slices stay done and uncommitted work is still in the workspace — and the old session takes no further turn. (FR-56, FR-57, FR-58)
- **AC-39** — A station worker's session killed at each point in its turn — before it starts, mid-turn, after committing some slices, before it returns — is followed by a new session for the same worker on the next run. The order carries on to shipped with no action beyond the run, and each dead session is recorded with its cause. (NF-4, FR-57, FR-58)
- **AC-40** — A finished order's record links each of its workers to every session it had, and names the session behind every action. Each session is readable in full: everything it was sent and everything it did. (FR-58, FR-60, FR-82)
- **AC-41** — The first operator action from a session registers that session, running above it, as the operator's, and the action is refused when no active session of the project runs above it. A second session trying to take on a station's worker is refused. (FR-59)
- **AC-42** — Every worker on a finished order has its own generated name and a role, each station's worker names the operator that created it, and each of its sessions has a harness and a process. A turn whose process has ended counts as over. (FR-60, FR-61)
- **AC-43** — Each station's worker starts on the model the user's settings name for its role, a role they leave out starts on their default, and a role with neither refuses to start. (FR-62)
- **AC-44** — A command whose environment claims to be the operator, with no registered process above it, is refused. So is a process reusing a registered process's id with a different start time, and a process started by a running station before its worker registers. (FR-63, FR-84)
- **AC-45** — With an owner environment holding API keys, a code-hosting token and an agent socket, neither a station's worker nor the check sees any of them, and each station's worker sees only the sign-in its own harness needs; with that sign-in unset, no worker starts. A file one worker leaves outside the workspace is not there for the next. (FR-64)
- **AC-46** — A station worker's attempt to write to the record directly, or to edit the running factory's code, instructions, hooks or settings, is refused and leaves them unchanged. A build that redefines the project's check is refused. (FR-39, FR-66)
- **AC-47** — An order that changes the project's check or a gate is judged by the default branch's check and gates until it ships. (FR-67)
- **AC-48** — Running an order from added to shipped leaves one log in which every action that touched the order appears once, in order, naming its worker's session or the factory — the factory's checks, rebase and landing included, each with its evidence attached — and no command changes or removes an entry. (FR-82, FR-83, FR-86)
- **AC-49** — A decision without a reason is refused, whether the operator or a station's worker makes it. After an order has run, each decision shows who decided it and why: the owner's approval carried out by the operator shows as the owner's, and one on a decision handed to the operator shows as the operator's. Each failed station, refused slice and stopped ship shows its cause as a code. (FR-14, FR-85)
- **AC-50** — A station stopped between any two of its writes leaves each slice commit and each return either whole or absent, and work returned after its turn closed records nothing. (FR-90)
- **AC-51** — Orders from two projects appear on one wall board with their title, project, station and worker, each in the column of its status — queued, running or shipped — a cancelled order appears in none, and the wall offers no way to change an order. (FR-91)
- **AC-52** — The wall refuses a request for the board or an order addressed to anything but this machine's local address, and a live connection opened from another website. (NF-2)
- **AC-53** — An artifact containing an image and a link shows neither as something the browser loads. (NF-3)
- **AC-54** — Across many runs of one order in which stations, ships and worker sessions are killed at random points, every run ends with the order shipped or a problem reported to the operator with its cause. Nothing is recorded twice, and the record differs from an undisturbed run only by the dead sessions it records. (NF-4, FR-23, FR-90)
- **AC-55** — Each `dim` command prints one structured result, and each refusal it prints carries a code, its details and the command that resolves it. (NF-5)
- **AC-56** — A session hook whose `dim` command fails or is missing still lets the session carry on. (NF-7)
- **AC-57** — A git hook in a repository whose owner, settings or check it cannot read lets the commit through. One that blocks a subject line, check or push says why. (NF-8)
- **AC-58** — A write sent through a reader's connection fails and leaves the database unchanged. (NF-9)
- **AC-59** — A query, `dim sql`, `dim trace` and the wall, given a record written by an older or newer version of the factory, each refuse it with the same error the writer raises, and leave it unchanged. (NF-9, NF-10)
- **AC-60** — An edit in a station worker's session, in a workspace that declares a format command, runs nothing, and a Claude worker whose workspace holds a settings file with a hook runs none of it. (NF-11)
- **AC-61** — A builder's write to the checkout's git hooks is refused, and a builder that changes the checkout's git config fails its station with the config put back as it was. (NF-12)
- **AC-62** — A plan, a build and a review each hand over exactly when their definition of done holds: a build with an uncommitted slice or an unanswered finding does not hand over, and each handed-over artifact waits for approval. (FR-48)
- **AC-63** — Every action on a finished order names the session that took it as recorded at that moment; an action sent from a process the factory cannot tie to a session is refused, and no command sets or changes who took an action. (FR-84)
- **AC-64** — A factory action in an order's log names the factory, the factory version that ran it and the action that caused it: a landing its approval, a refused slice its commit, a replaced session the session that died. (FR-82)
- **AC-65** — Deleting the trace leaves every order's log and next step unchanged, and `dim trace` follows one order's factory steps while it runs. (FR-87)
- **AC-66** — The time each station took, the returns and review rounds per order, and how often sessions died are each answered by a query over the order logs and session record. (FR-88)
- **AC-67** — A setting in a project's committed settings overrides the same setting in the user's, an order in that project follows the project's value, and a setting the factory does not know is refused. How a project ships is read from its settings, on its default branch and never from an order's changes. (FR-4, FR-5, FR-67)
- **AC-68** — A builder's commit names the owner's git identity as author and committer and carries no signature, in a checkout whose config signs commits. (FR-42)
- **AC-69** — A project hook in the checkout runs on a builder's commit, and a hook that refuses the commit leaves it uncommitted. (FR-43)
- **AC-70** — In a checkout whose config signs commits, every commit that lands on the default branch is signed with the owner's key, and a landing whose key cannot be reached leaves the default branch where it was and the order ready to ship again. (FR-21)
- **AC-71** — An opened order shows its facts, each artifact it has rendered as a document, each station worker's calls and tokens apart from its subagents', each split by what put the context there, and every entry of its log in order, and a new artifact or log entry appears on an open order and on the board without a reload. With the record unreadable, the wall says so and shows no order as current. (FR-92, FR-93)
- **AC-72** — With the wall served in development mode, an edit to the wall's code shows on the open page without a manual reload. (FR-94)
- **AC-73** — An order in a project whose check needs a dependency its lockfile pins ships, with that dependency installed in the workspace before the plan station works and none of the project's lifecycle scripts run. (FR-7, FR-9)
- **AC-74** — An install that fails stops the run with a refusal naming the command, and no station works on the order. (FR-8)
- **AC-75** — A build whose check writes inside the workspace, in its temporary directory and outside both hands over, and only the write outside is refused. (FR-65)
- **AC-76** — In a project that pins a tool version the operator's environment does not find first, the check and a station's worker each run the pinned version, and the order ships. (FR-10)
- **AC-77** — A toolchain that cannot be resolved stops the run with a refusal naming its cause, and no station works on the order. (FR-11)
- **AC-78** — After an order's planner has worked and the record is synced, the planner's session and its tool calls are in the record, joined to the planner by name; a planner whose turn ran a subagent has that subagent's tool calls in the record too, reached through the subagent's parent to the planner. (FR-89)
- **AC-79** — Adopting a TypeScript project with no gates and choosing every canonical gate installs each, after which a commit with a long subject, a commit whose check fails, and a commented line each fail with no `dim` on the path; choosing the comment ban in a project with no code it reads is refused and nothing is written; installing with no choice made outside a terminal is refused. (FR-80, FR-95, FR-96, FR-97)
- **AC-80** — Installing the gates again changes nothing; after a canonical gate changes, installing replaces only that gate; choosing fewer gates removes only the dropped one; a gate file the project added beside them is left as it is. (FR-97)
- **AC-81** — `dim doctor` in a project's checkout with one chosen gate missing, one behind, one changed in place, one present but not chosen, and no shipping setting reports each with what resolves it, and leaves the checkout, its settings and the record unchanged. (FR-98)
- **AC-82** — An order in a project whose settings name `verify` as its check, while it also declares a failing `check`, is built and judged by `verify`, and its builder's brief names `verify`. (FR-99)
- **AC-83** — A build whose head fails the project's check, or whose check rewrites files, is refused at its return with the check's output in the log and stays at build without failing the station; once a further commit makes the check pass, the same return hands the build over with the passing check in the log. (FR-86, FR-100)
- **AC-84** — A planner's and a reviewer's own edit to a project file is refused, while each runs a program that writes tracked, untracked and ignored files in the workspace and commits on the order's branch; the next station starts at the order's recorded head with only the ignored files kept, and neither turn's commit reaches the order's work. (FR-36, FR-44, FR-101, FR-102)
- **AC-85** — A planner's turn is allowed to search the web and fetch pages, and a builder's or reviewer's turn is not. (FR-103)
- **AC-86** — Every station turn is offered exactly the shell, reading, writing and editing files and starting subagents, and the planner's turn the web tools beside them. (FR-103, FR-104)

## 11. Constraints

- **C-1** — Shipping lands on the local default branch. Nothing is pushed.
- **C-2** — The record stays on the owner's machine and works under any harness.
- **C-3** — Station workers run under Claude Code.
- **C-4** — The wall's server pushes each change to the open page over a WebSocket; the page never polls.

## 12. Open decisions

- How the admitted actions are worked out from the record, within FR-25.
- How a kept workspace or branch is reported, within FR-24.
- Shipping as a pull request instead of landing on the default branch, within C-1. The factory pushes the order's branch and opens the pull request, with the plan, Build and Review artifacts as its description. A merge ships the order; a failing check or a conflict sends it back to build; a return while the pull request is open runs build; and a comment on the pull request reaches only the operator, never a worker (FR-52).
- A factory halt, during which no station or ship starts, and after which every order resumes where its record puts it, within FR-25 and FR-30.
- How the owner hands a decision to the operator, and for which artifacts, within FR-85.
- Splitting a station's work over several workers, such as one reviewer per area, within FR-56.
- Hosting the wall off the owner's machine, such as to watch it from a phone: what leaves the machine and how reading stays limited to the owner, within NF-2 and C-2.
