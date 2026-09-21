---
name: dim-add
description: Turn a build request into one attributed factory order.
argument-hint: "<what needs to be built>"
---

# Add

Turn the request into the one order the operator will run. This is intake, not planning: preserve the request, make its identity durable, and hand back the id.

## Entry contract

- The request states what should become true in ordinary project language.
- Read the repository's project and factory rules before choosing the order's project.
- Use `dim q search` or `dim q prior-art` only when the request refers to an earlier decision or existing order; do not redesign the request here.
- Run intake under the operator identity assigned to the project.

## Write the order

1. Choose a stable kebab-case order id from the request. Do not put a timestamp or model name in it.
2. Write a short title that names the requested outcome.
3. Keep the request's detail in `--description`; do not replace it with a plan or implementation outline.
4. Use the repository's canonical project identity.
5. Run:

   ```text
   dim order add <order-id> --title "<title>" --description "<request>" --project "<owner/repo>"
   ```

6. Verify the command returned the same id and that `dim q order <order-id>` reads the queued record.
7. Hand the id to the operator loop. Do not claim, plan, approve, build, review, ship, or drop it here.

## Result

Return only the order id and the next action:

```text
<order-id> — hand this order to the operator.
```

## Exit check

The order is added when:

- exactly one order was written;
- its title, description, and project are the request's durable intake record;
- the write is attributed to the current worker;
- no planning or implementation decision was added.

## Red flags

- inventing a plan while writing the order
- creating a second order for one request
- using a worker name or token from a flag or prose instead of the environment
- claiming or starting the order during intake
- adding a timestamp or model name to the id
- silently dropping request details
