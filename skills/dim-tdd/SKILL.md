---
name: dim-tdd
description: Drive a behavior-changing factory slice through red, green and refactor while preserving evidence for each cycle.
argument-hint: "<behavior to add or change>"
---

# TDD

Use this shared capability inside a build station when a slice changes observable behavior. It supplies the red-green-refactor method; the station supplies the slice boundary, repository check and commit evidence.

## Red

Understand the public behavior and write one test that describes the next change. Run it and confirm that it fails for the intended reason. Keep the test at the public interface and pin wire values as literals where the contract carries them.

## Green

Make the smallest implementation that passes the failing test. Do not add speculative cases, unrelated cleanup or a second behavior before the first one is green.

## Refactor

Simplify the implementation while the test is green. Preserve behavior, run the focused test after each change and leave tests untouched during a simplification-only pass.

## Repeat and report

Repeat one behavior at a time. Run the repository's declared check before the slice reaches the checker. Report the red failure, green result, refactor result and any behavior intentionally left outside the slice.

## Red flags

- writing all tests before implementing any behavior
- claiming red without running the test
- testing private implementation details
- mocking internal functions instead of system boundaries
- refactoring while the test is red
- using a test to ratify behavior that was never observed
