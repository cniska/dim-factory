---
name: dim-simplify
description: Simplify a green slice without changing its behavior or any test, until a pass changes nothing. Use from dim-build after a slice's check passes.
---

# Simplify

Read the slice's own diff and nothing else. A file the slice did not touch is a separate change.

An edit lands only by lowering a reader's cost, and names which: a name that has to be held in the head, a nesting level that carries no case, a block written twice, a wrapper or abstraction with one caller, computation mixed with formatting, a branch on the same value taken twice. Shorter is not simpler, and a line that reads plainly stays. Follow the project's idioms. When a choice looks unnecessary, read its callers and tests for the reason it exists, and leave it when the reason still holds.

Behavior is preserved exactly, and the test for that is mechanical: the project's check passes again and this pass's diff touches no test file. A test edited to admit a simplification means the behavior moved, which is a different change.

Run the pass again only when the last one changed something, since one simplification exposes another. A pass that can name no cost is the fixpoint, and is the expected result on a slice that was already plain.
