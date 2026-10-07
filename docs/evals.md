# Evals

An eval measures what an instruction changes. It runs a model in a small throwaway repo, several times with the instruction and several times without, and counts how often each side does the checked thing. One good run shows only that an instruction reads well.

The eval tool lives in [`evals/`](../evals) and stands apart from the factory: it imports nothing from `src/`, and it reads only the instruction files it tests. Its first cases test the stations' instructions under `prompts/`.

```sh
CLAUDE_CODE_OAUTH_TOKEN=... bun run eval plan-return-file
bun run eval plan-return-file --runs 2
```

## A case

A case is a folder under [`evals/cases/`](../evals/cases):

- `scaffold.sh` builds the throwaway repo in `$WORKSPACE`.
- `prompt.md` is what a user would type, without naming the instruction.
- `case.json` names the instruction under test, the model, the tools, the number of runs per side and the graders.

Each run starts `claude -p` in the case's repo with its own `HOME` and `TMPDIR`, so no personal settings, memory or skills load. The with side gets the instruction appended to the system prompt, the way a station's worker gets its instructions. Each run's transcript is kept under `evals/results/`.

## Graders

A grader reads what the agent did: the tool calls in the run's transcript and the files it left. It never reads what the agent said. Each grader keeps a passing and a failing transcript in `evals/graders/fixtures/`, and `bun run check` runs every grader on them without calling a model, so a grader nobody has seen fail cannot slip in.

A case whose without side passes every run measures nothing, and the run says so and exits non-zero.
