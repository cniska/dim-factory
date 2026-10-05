# Add

Intake, not planning: keep the request, make it an order, hand back the id. One request is one order.

1. The title names the outcome in the project's words.
2. The description is the request as the owner gave it: what should become true, every detail they named, and a report's stack or log verbatim. It is not a plan or an outline; the planner reads it from the brief. The wall shows it as plain text, so it reads unrendered.
3. The project is the checkout's own unless the owner names another. From inside a checkout of the project, run `dim order add --title "<title>" --description "<request>" [--project <owner>/<repo>]`.
4. The result prints the order with its id.

`dim query search "<words>"` serves only a request that refers to an earlier decision.
