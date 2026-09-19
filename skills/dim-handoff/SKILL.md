---
name: dim-handoff
description: Write a strict station handoff for the next factory agent.
argument-hint: "<queue item>"
---

# Handoff

Write what a later station needs, from the work and evidence you inspected yourself.

## Shape

Two headings, both required, and nothing else in the output:

```
# Handoff — <item id> — <item title>
## Next
<one action>
```

- `## Next` holds one concrete action. It is not a recap of what happened.
- The id is the item's own, and the title is the one the queue states it in. Neither is written from memory.
- Anything the record does not hold is not in the handoff. An action inferred from what was merely discussed sends the next station somewhere nothing can confirm.

## Why it is this short

The receiving station reads the order report and its evidence with `dim`, so everything the handoff would repeat is already there and already true. What it cannot get on its own is which item it is on. That pointer is the whole job.
