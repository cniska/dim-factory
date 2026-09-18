---
name: dim-handoff
description: Write a strict station handoff for the next factory agent.
argument-hint: "<queue item>"
---

# Handoff

Write the transfer a later station needs from the work and evidence you actually inspected. Output a title line in the form `# Handoff — <item_id> — <item name>`, followed by an `## Next` heading and one concrete action.

The `# Handoff` and `## Next` headings are required. Use `## Next` for one action, not a recap. The item ID is canonical; the name is the queue's display name and is never invented here. Do not infer either or the next action from context that was not recorded. The receiving station queries the order report and its evidence with `dim`. The handoff transfers only the routing token. Output only the handoff.
