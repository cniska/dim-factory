---
name: dim-artifact
description: Write a human-facing factory artifact from recorded evidence. Use when a station worker must explain its outcome to the owner.
argument-hint: "<station> <evidence>"
---

# Artifact

A station worker writes an artifact as its explanation for the owner. It is not a transcript, a second plan, or a review of the worker's prose. The record is the authority: write what the evidence supports, and name what it does not.

## Write the artifact

1. Lead with the outcome and why it matters to the order.
2. Keep the detail proportional to the change. A small change needs a short artifact; a broad or risky change needs the contracts, evidence and decisions an owner must check.
3. Use Markdown that reads without the worker session. Keep commands, paths, identifiers and decisions exact where they let the operator verify a claim.
4. Separate facts from judgment. Name the evidence behind a conclusion and label unresolved risks, assumptions and deviations instead of smoothing them over.
5. Attribute the artifact to the worker that wrote it. Attribute findings, approvals and other acts to the worker that performed them; never borrow the operator's identity for missing evidence.
6. Do not invent evidence, claim a check passed from an exit message, or repeat the same fact in several sections.

The station supplies the artifact's subject and required sections. Write one artifact for the worker's completed work. The operator checks it against the record and decides whether the order advances. A later revision is a new artifact with its own worker, evidence and approval.

## Size

Use the smallest structure that lets the operator decide. Prefer a short heading and compact sections over a fixed template. Add detail only when it reduces uncertainty about the outcome, evidence, risk or next decision.

## Red flags

- writing a transcript instead of an outcome
- describing intended work as completed work
- hiding an unresolved risk behind a confident verdict
- copying evidence without explaining what it proves
- using a fixed length for changes of different size
- attributing a station act to the operator because the worker did not report it

## See also

- `dim-station-plan`
- `dim-station-build`
- `dim-station-review`
