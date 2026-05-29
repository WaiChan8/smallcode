---
name: tdd
trigger: match
keywords: [test, tdd, implement, feature, bugfix]
---

# Test-Driven Development

Strict red/green/refactor for small models that over-implement.

## Cycle

1. **Write the failing test first.** Call `tdd_begin_cycle` with the test name to enter the RED phase.
2. **Confirm red.** Call `run_tests` with `test_filter` set to the new test name. The TDD state machine will auto-confirm RED if the test fails. Do NOT write implementation until red is confirmed.
3. **Minimum code to pass.** Write only the code the test requires. No extra logic. No preemptive abstractions.
4. **Confirm green.** Call `run_tests` again. The state machine will auto-advance to GREEN if the target test passes.
5. **Refactor (optional).** Call `tdd_advance` to enter the REFACTOR phase. Make structural improvements, then call `run_tests` (full suite) to verify no regressions. The state machine will complete the cycle on a clean run.

## State machine tools

| Tool | When to call |
|------|-------------|
| `tdd_begin_cycle` | After writing the new test, before running anything |
| `run_tests` | At every phase boundary — the machine auto-transitions |
| `tdd_status` | To check current phase and what is required next |
| `tdd_advance` | To trigger a phase transition (green→refactor, refactor→idle) |
| `tdd_reset` | To abandon the current cycle |

## Phase gates enforced automatically

- **RED (unconfirmed):** writing implementation files is blocked until `run_tests` confirms the target test fails.
- **GREEN:** modifying test files is blocked.
- **REFACTOR→IDLE:** completing the cycle is blocked until `run_tests` confirms the full suite is clean.

## Rules

- One behavior per test. Commit each green state.
- Never batch test + implementation in one commit.
- Bug fixes: write a regression test that fails on the old behavior, then fix.
- Use `run_tests` (not bare `bash`) for all test runs during TDD — the structured output drives the state machine.

## SmallCode tips

- After green, `memory_remember` type `workflow` if you discovered a project-specific test command or quirk.
- `run_tests test_filter` narrows to a single test — faster red-phase confirmation on large suites.
