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
3. Use Markdown that reads without the worker session. Give every included dimension its own `##` heading; do not compress the artifact into one paragraph. Keep commands, paths, identifiers and decisions exact where they let the operator verify a claim.
4. Separate facts from judgment. Name the evidence behind a conclusion and label unresolved risks, assumptions and deviations instead of smoothing them over.
5. Attribute the artifact to the worker that wrote it. Attribute findings, approvals and other acts to the worker that performed them; never borrow the operator's identity for missing evidence.
6. Do not invent evidence, claim a check passed from an exit message, or repeat the same fact in several sections.

The station supplies the artifact's subject and required sections. Use the station's section names as headings and omit only a section the evidence cannot support. Write one artifact for the worker's completed work. The operator checks it against the record and decides whether the order advances. A returned artifact is feedback for the same station: address the stated gap, then write a new revision under the same station worker identity. Keep the earlier artifact unchanged so the record shows what was returned and what changed. Each revision has its own evidence and approval.

## Size

Size the artifact to the change. There is no fixed template or target length: write only enough for the owner to decide and the next worker to act.

Choose the dimensions from the change's boundary and risk before drafting it:

- A narrow change needs the outcome, the evidence that supports it and the check that proves it.
- A multi-part change also needs its boundary and independently verifiable slices.
- A cross-boundary or risky change also needs the contracts, owner decisions and risks that determine whether it can proceed.

Use only the dimensions that earn their place. Omit empty sections, exhaustive file inventories, repeated evidence and implementation detail that does not reduce an owner's uncertainty.

A short artifact may have one or two sentences under a heading. It still uses headings when it includes more than one dimension. A status paragraph, command transcript or slice-by-slice diary is not an artifact.

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
