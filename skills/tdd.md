---
name: tdd
trigger: match
keywords: [tdd, test, implement, feature, requirements]
---

# TDD Loop

Call `tdd_loop` with the list of behaviours to implement:

```
tdd_loop(requirements=["add() returns the sum", "add() raises TypeError on bad input"])
```

Then for each requirement: **write a failing test, then write the minimum implementation to pass it.**

The harness runs tests automatically after every file write, advances the phase when the target test goes green, and moves to the next requirement when the cycle is done. The loop completes only when all requirements are green and the full suite is clean.

Use `tdd_status` to see current progress.
