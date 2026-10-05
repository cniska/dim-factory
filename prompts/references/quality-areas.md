# Quality areas

The questions a review of a change and an audit of existing code read against, one reader per area. A finding needs a concrete consequence and source evidence; a preference or a hypothetical cost is not a finding. Each finding is checked at its source before it is reported, and findings that duplicate or contradict each other are resolved first.

| Area | Question |
|---|---|
| Correctness | Do entry points, state changes and failure paths fulfill their stated behavior and caller contracts? |
| Tests | Would the tests fail on a credible regression in important behavior? Do they duplicate stronger proof, assert incidental implementation details or keep test-only production code alive? |
| Architecture | Does the code copy the shape the code beside it uses, or bring a second way of doing a thing the project already does one way? Do responsibilities, dependencies and extension points follow the project's stated boundaries, and does each abstraction carry a policy or invariant? |
| Maintainability | Do names, control flow and local patterns make the code understandable and changeable, and is it no more complex than its outcome needs? Does each concept have one name across code, commands, skills and docs, as the glossary has it? |
| Docs | Do the pages that describe this behavior describe it as it is, with its commands and words? |
| Security | Can a concrete path cross a trust boundary, expose sensitive data or execute unsafe input? |
| Performance | Does a changed path repeat work, grow without a bound or misuse a resource? |

Correctness and architecture are separate readers: a reader given both questions answers the one it read last.
