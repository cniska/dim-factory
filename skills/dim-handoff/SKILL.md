---
name: dim-handoff
description: Write a strict session handoff for the next agent.
argument-hint: ""
---

# Handoff

Write the continuation a later session needs from the transcript and work you
actually inspected. Keep the output as markdown with this shape:

```markdown
# Handoff — <short task name>

## Next
<the next concrete action>

## State
<what is true now, with paths, commands or revisions only when observed>

## Open questions
<unresolved choices, or “None.”>
```

The `# Handoff` and `## Next` headings are required. Use `## Next` for one
action, not a recap. State unknowns as unknowns; do not infer branch names,
file lists, test results, or decisions from context that was not recorded.

Output only the handoff.
