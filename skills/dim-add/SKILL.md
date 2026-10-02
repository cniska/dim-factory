---
name: dim-add
description: Turn what the owner asks for into one factory order with a title, a description and a project. Use in the operator's session when the owner asks for work to be built or fixed.
argument-hint: "<what should become true>"
---

# Add

Intake, not planning: keep the request, make it an order, hand back the id.

1. The title names the outcome in the project's words.
2. The description is the request as the owner gave it: what should become true, every detail they named, and a report's stack or log verbatim. It is not a plan or an outline; the planner reads it from the brief. The wall shows it as plain text, so it reads unrendered.
3. The project is the checkout's own unless the owner names another. From inside a checkout of the project, run `dim order add --title "<title>" --description "<request>" [--project <owner>/<repo>]`.
4. The result prints the order with its id. Hand the id back; the owner runs it through `dim-factory`.

One request is one order. `dim query search "<words>"` serves only a request that refers to an earlier decision.
