# Adopt

Adopting makes a project one the factory can run orders in. Every step runs from the project's checkout, and `dim doctor` lists what is left: each failing row names what resolves it. Settle what the project's own files answer; ask the owner only what they do not.

1. `dim doctor`. Work through its project rows in the order below, then run it again until each is ok.
2. **Check.** Find the task that says a change is sound in the project's manifests, CI workflows and contributor docs. Record the name the project already uses, `dim config set tasks.check <task> --project`, and never rename the project's task. Do the same for a format task not named `format`, with `tasks.format`. When more than one task could be the check, ask the owner which.
3. **Ship.** Ask the owner whether the project lands changes straight on its default branch. Only then set `dim config set ship default-branch --project`; a project that lands through pull requests is not adopted yet.
4. **Gates.** Ask the owner which canonical gates the project runs: `commit-subject`, `check`, `no-comments`. Before `no-comments`, run `dim comments purge --write`, then the check, and commit that apart from the gates. Then `dim gates install <gate>...`, and drop the project's own copy of a rule a chosen gate now holds, such as a subject-length rule in its contributor docs.
5. Commit `.dim/config.json` and the installed gate files on the default branch on the owner's go, with no order in flight.

The git identity and the worker sign-in are the owner's own: when doctor reports either, hand it to the owner with the fix doctor names.
