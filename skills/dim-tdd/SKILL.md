---
name: dim-tdd
description: Red, green, refactor for a slice that changes behavior, with each test proven to catch what it claims. Use from dim-build on a behavior-changing slice.
---

# TDD

## Red

Write one test at the public interface that describes the next behavior. Run it and read why it fails: the reason is the behavior missing, not an import or a typo. Pin wire values as literals, such as header names, record fields and status codes; importing the production constant lets a rename ratify itself.

## Green

Make the smallest change that passes. No second behavior and no cleanup before the first is green.

## Refactor

With the test green, simplify the implementation under `dim-simplify`. The test does not change.

## Prove the test

A test claiming an invariant must fail when the invariant is removed: delete the check, run the test, watch it go red, put the check back.

Read each test for passing by its own doing: an assertion made after the resource it checks is released, a `?? null` default that makes the expected and the actual value meet, a comparison of a value to itself, a mock of the function under test.

A fake standing in for a real thing is as strict as the real thing: built from recorded real behavior, refusing every flag and input the real thing refuses, so a test green against the fake is green against the real thing.
