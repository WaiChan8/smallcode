// SmallCode — TDD Governor
//
// Integrates the TDD state machine with the agent loop. Provides:
//
//   1. checkToolCall(name, args) — called before each tool execution; returns
//      a correction injection string if the phase gate fires, null if ok.
//
//   2. processTestResult(result) — called after run_tests completes; attempts
//      automatic phase transitions (red→green, refactor→idle) and returns a
//      status message to inject into the conversation.
//
//   3. phasePrompt() — returns a brief context injection for the system prompt.
//
// This keeps TDD enforcement in one place, separate from the quality monitor
// (which handles structural model failures) and the early-stop detector.

'use strict';

const { getTDDState } = require('../session/tdd_state');

class TDDGovernor {
  constructor(options = {}) {
    this._state = options.state || getTDDState({ workdir: options.workdir });
  }

  get state() { return this._state; }

  /**
   * Called before executing any write tool. If the current TDD phase forbids
   * the write, returns an injection string the loop injects as a user message.
   * Returns null if the tool call is allowed.
   */
  checkToolCall(toolName, toolArgs) {
    return this._state.checkToolCall(toolName, toolArgs);
  }

  /**
   * Called after run_tests completes. Attempts automatic phase transitions
   * based on the result and returns a summary string to inject.
   *
   * Logic:
   *   RED (unconfirmed) + failing  → confirmRed() → inject "test is red"
   *   RED (confirmed)   + passing  → advanceToGreen() → inject "now green"
   *   REFACTOR          + clean    → completeCycle() → inject "cycle done"
   *   anything else                → null
   *
   * @param {object} testResult - Structured result from run_tests
   * @returns {string|null}
   */
  processTestResult(testResult) {
    const phase = this._state.phase;

    if (phase === 'red') {
      if (!this._state.redConfirmed) {
        // Try to confirm red — if tests are failing, that's what we want
        const r = this._state.confirmRed(testResult);
        return r.message;
      }
      // Red is confirmed — check if target is now passing (model wrote implementation)
      if (testResult && testResult.exitCode === 0 && testResult.failed === 0 && testResult.passed > 0) {
        const r = this._state.advanceToGreen(testResult);
        return r.message;
      }
      return null;
    }

    if (phase === 'refactor') {
      // After a full-suite run with no failures, complete the cycle
      if (testResult && testResult.failed === 0 && testResult.errors === 0 && testResult.passed > 0) {
        const r = this._state.completeCycle(testResult);
        return r.message;
      }
      return null;
    }

    return null;
  }

  /**
   * Returns the current phase prompt to inject into the system context.
   * Call this when building the system prompt for each turn.
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
