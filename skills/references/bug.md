# A bug

An order that describes a defect is planned, built and reviewed as one: the cause is named before any fix, a test fails on the defect before the code changes, and the fix repairs the cause. Each station reads its own part.

## Plan

- Triage against the record. `dim query search "<words the symptom would use>"` finds an attempt that was talked about and abandoned, and `dim query thread <session>@<when>` reads the exchange around a hit.
- Where the defect arrived as a report, read it before the code. A stack, a log or a fault body says which line ran; a description says what someone noticed.
- Reproduce the defect in the workspace. One explanation accounts for every symptom; two candidates mean triage is not finished, and the test that tells them apart is the first slice.
- The plan names the cause and the line believed wrong. The first slice's outcome is the test that fails on the defect.
- Where triage finds no defect, return the order with what the code does and why it is right. A fix written to justify having started is the defect.

## Build

- Write the test that fails because of the defect, run it and read the failure before editing the code it covers. A test written after the fix was written against code that already worked.
- The test fails on the defect in the code as it was, not on a missing import of what the fix adds.
- Fix the cause the plan names. Where the cause turns out to be out of reach, return the order with the real options rather than patch the symptom.
- The test stays in the slice, and the commit subject names the cause in plain words.

## Review

- The named cause is fixed rather than a symptom. A special case, a guard, a retry or a default that makes the symptom go away while the defect stays is a finding.
- A test in the diff fails without the fix: read it against the code as it was, not only as it is.
- A defect of the same shape left standing within the order's reach is a finding.
