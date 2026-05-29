// SmallCode — TDD Governor
//
// Integrates the TDD state machine with the agent loop. Drives automatic phase
// transitions after every run_tests call and enforces phase gates before writes.
//
// In loop mode (after tdd_loop is called with requirements), processTestResult
// drives the full Red→Green→(Refactor)→next-requirement cycle until all
// requirements are fulfilled and a clean regression run passes.
//
// Automatic transitions triggered by processTestResult():
//
//   RED (unconfirmed) + failing result  → confirmRed()
//   RED (confirmed)   + passing result  → advanceToGreen()
//   REFACTOR          + clean result    → completeCycle()  (loop: auto-advance)
//   IDLE (loop, all done) + clean suite → markRegressionClean() → loop complete
//
// Returns a status message to inject into the conversation after each transition.

'use strict';

const { getTDDState } = require('../session/tdd_state');

class TDDGovernor {
  constructor(options = {}) {
    this._state = options.state || getTDDState({ workdir: options.workdir });
  }

  get state() { return this._state; }

  /**
   * Called before executing any write tool. Returns a correction injection
   * string if the current TDD phase forbids the write, null if allowed.
   */
  checkToolCall(toolName, toolArgs) {
    return this._state.checkToolCall(toolName, toolArgs);
  }

  /**
   * Called after every run_tests completes. Attempts automatic phase
   * transitions and returns a summary string to inject into the conversation,
   * or null if no transition occurred.
   *
   * @param {object} testResult - Structured result from run_tests
   * @returns {string|null}
   */
  processTestResult(testResult) {
    const phase = this._state.phase;

    // ── RED phase ──────────────────────────────────────────────────────────
    if (phase === 'red') {
      if (!this._state.redConfirmed) {
        const r = this._state.confirmRed(testResult);
        return r.message;
      }
      // Red confirmed — check if target is now passing (impl written)
      if (testResult && testResult.exitCode === 0 && testResult.failed === 0 && testResult.passed > 0) {
        const r = this._state.advanceToGreen(testResult);
        return r.message;
      }
      return null;
    }

    // ── REFACTOR phase ─────────────────────────────────────────────────────
    if (phase === 'refactor') {
      if (testResult && testResult.failed === 0 && testResult.errors === 0 && testResult.passed > 0) {
        const r = this._state.completeCycle(testResult);
        return r.message;
      }
      return null;
    }

    // ── IDLE phase with active loop ────────────────────────────────────────
    // When all requirements are done and a clean suite runs, the loop completes.
    if (phase === 'idle' && this._state.loopActive) {
      if (this._state.allRequirementsDone()) {
        const isClean = testResult && testResult.failed === 0 && testResult.errors === 0 && testResult.passed > 0;
        if (isClean) {
          this._state.markRegressionClean();
          const done = this._state.requirements.length;
          const checklist = this._state.requirements
            .map(r => `  ✓ ${r.id}: ${r.text}`)
            .join('\n');
          return `[TDD LOOP COMPLETE] All ${done} requirement(s) fulfilled and full suite is clean.\n${checklist}`;
        }
        return '[TDD LOOP] All requirements are green. Run run_tests (full suite, no filter) to confirm no regressions and complete the loop.';
      }
      // There is an active or pending requirement waiting to be worked on
      const next = this._state.activeRequirement() || this._state.pendingRequirements()[0];
      if (next) {
        const done = this._state.doneRequirements().length;
        const total = this._state.requirements.length;
        return `[TDD LOOP] ${done}/${total} done. Next requirement: "${next.text}" (${next.id}). Write a failing test for it, then call tdd_begin_cycle.`;
      }
    }

    return null;
  }

  /**
   * Returns the current phase prompt to inject into the system context.
   */
  phasePrompt() {
    return this._state.phasePrompt();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance = null;

function getTDDGovernor(options) {
  if (!_instance) _instance = new TDDGovernor(options || {});
  return _instance;
}

function resetTDDGovernor() { _instance = null; }

module.exports = { TDDGovernor, getTDDGovernor, resetTDDGovernor };
