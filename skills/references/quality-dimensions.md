# Quality dimensions

Use these questions for both review of a change and audit of existing code. A finding needs a concrete consequence and source evidence.

| Dimension | Question |
|---|---|
| Correctness | Do entry points, state changes and failure paths fulfill their stated behavior and caller contracts? |
| Tests | Would tests fail on credible regressions in important behavior? Do they duplicate stronger proof, assert incidental implementation details or keep test-only production code alive? |
| Architecture | Do responsibilities, dependencies and extension points follow the project's stated boundaries? Does an abstraction carry a policy or invariant? |
| Maintainability | Do names, control flow and local patterns make the code understandable and changeable? Does each domain concept have one name across code, commands, skills and docs? Compare the glossary with live usage and distinguish separate concepts that have similar names. |
| Docs | Do the relevant pages describe current behavior, commands and vocabulary? |
| Security | Can a concrete path cross a trust boundary, expose sensitive data or execute unsafe input? |
| Performance | Does a sensitive path repeat work, grow without a bound or misuse resources? |

Review judges those questions on the change and its resulting behavior. Audit judges them on existing code within its declared scope. Each skill defines its additional dimensions and evidence rules.
