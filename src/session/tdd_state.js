// SmallCode — TDD State Machine
//
// Tracks the Red → Green → Refactor cycle so the agent loop can gate tool
// availability and enforce phase discipline. Without this, a small model
// skips straight to writing implementation (not TDD).
//
// Phase model:
//
//   idle      No TDD cycle in progress. All tools available.
//   red       A new failing test was written. The agent MUST call run_tests
//             and confirm the target test fails before writing implementation.
//             Writing implementation files is permitted only after confirmRed().
//   green     The target test now passes. The agent MUST NOT modify test files.
//             It may only edit implementation files to reach green.
//   refactor  Implementation is green. Agent may restructure — but only
//             structural changes. A clean full-suite run is required before
//             the cycle is considered complete.
//
// Transitions:
//
//   idle  ──beginCycle(testName)──►  red
//   red   ──confirmRed(result)──►    red (confirmed=true)
//   red   ──advanceToGreen(result)── green   (requires confirmRed first)
//   green ──enterRefactor()──►       refactor
//   refactor ──completeCycle(result)─► idle  (requires clean full-suite run)
//   any   ──reset()──►               idle
//
// Persistence:
//   State is written to .smallcode/tdd_state.json on every transition so it
//   survives session restarts. On load, the machine resumes from the last
//   persisted phase.
//
// Configuration:
//   SMALLCODE_TDD=false    disable entirely (machine stays idle, no gates fire)

'use strict';

const fs = require('fs');
const path = require('path');

const PHASES = Object.freeze({
  IDLE: 'idle',
  RED: 'red',
  GREEN: 'green',
  REFACTOR: 'refactor',
});

const FILE_MODE = 0o600;

class TDDStateMachine {
  constructor(options = {}) {
    this.workdir = options.workdir || process.cwd();
    this.disabled = options.disable || process.env.SMALLCODE_TDD === 'false';
    this._stateFile = options.stateFile
      || path.join(this.workdir, '.smallcode', 'tdd_state.json');

    // In-memory state
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._cycleId = 0;
    this._startedAt = null;

    if (!this.disabled) {
      this._load();
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get phase() { return this._phase; }
  get targetTest() { return this._targetTest; }
  get redConfirmed() { return this._redConfirmed; }

  isIdle()     { return this._phase === PHASES.IDLE; }
  isRed()      { return this._phase === PHASES.RED; }
  isGreen()    { return this._phase === PHASES.GREEN; }
  isRefactor() { return this._phase === PHASES.REFACTOR; }
  isActive()   { return this._phase !== PHASES.IDLE; }

  // ─── Transitions ───────────────────────────────────────────────────────────

  /**
   * Start a new TDD cycle for the named test.
   * Call this after writing the failing test, before running it.
   * Moves to the RED phase.
   *
   * @param {string} testName - The specific test identifier to track (e.g. "test_add" or "src/math.test.js > adds numbers")
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  beginCycle(testName) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (!testName || typeof testName !== 'string' || !testName.trim()) {
      return { ok: false, phase: this._phase, message: 'beginCycle requires a non-empty testName.' };
    }

    this._phase = PHASES.RED;
    this._targetTest = testName.trim();
    this._redConfirmed = false;
    this._cycleId = (this._cycleId || 0) + 1;
    this._startedAt = new Date().toISOString();
    this._save();

    return {
      ok: true,
      phase: PHASES.RED,
      message: `TDD cycle started for "${this._targetTest}". Now run_tests to confirm it fails (RED phase).`,
    };
  }

  /**
   * Record that run_tests was called and confirmed the target test is FAILING.
   * Must be called before advanceToGreen is allowed.
   *
   * @param {object} testResult - Structured result from run_tests
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  confirmRed(testResult) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.RED) {
      return { ok: false, phase: this._phase, message: `confirmRed called but phase is "${this._phase}", expected "red".` };
    }

    const targetFailing = this._isTargetFailing(testResult);
    if (!targetFailing && testResult && testResult.failed === 0 && testResult.exitCode === 0) {
      return {
        ok: false,
        phase: PHASES.RED,
        message: `RED phase confirmation failed: all tests passed — "${this._targetTest}" is not failing yet. ` +
          'Write the test first, then call run_tests to confirm it fails before implementing.',
      };
    }

    this._redConfirmed = true;
    this._save();

    return {
      ok: true,
      phase: PHASES.RED,
      message: `RED confirmed: "${this._targetTest}" is failing as expected. Now write the minimum implementation to make it pass.`,
    };
  }

  /**
   * Advance from RED → GREEN after run_tests shows the target test passing.
   *
   * @param {object} testResult - Structured result from run_tests
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  advanceToGreen(testResult) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.RED) {
      return { ok: false, phase: this._phase, message: `advanceToGreen called but phase is "${this._phase}".` };
    }
    if (!this._redConfirmed) {
      return {
        ok: false,
        phase: PHASES.RED,
        message: 'Cannot advance to GREEN: red phase not confirmed yet. Call run_tests first to confirm the test fails.',
      };
    }

    const targetPassing = this._isTargetPassing(testResult);
    if (!targetPassing) {
      return {
        ok: false,
        phase: PHASES.RED,
        message: `"${this._targetTest}" is still failing. Fix the implementation until it passes, then advance to GREEN.`,
      };
    }

    this._phase = PHASES.GREEN;
    this._save();

    return {
      ok: true,
      phase: PHASES.GREEN,
      message: `GREEN: "${this._targetTest}" is now passing. You may enter REFACTOR phase or commit and start the next cycle.`,
    };
  }

  /**
   * Enter the REFACTOR phase from GREEN.
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  enterRefactor() {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.GREEN) {
      return { ok: false, phase: this._phase, message: `enterRefactor called but phase is "${this._phase}", expected "green".` };
    }

    this._phase = PHASES.REFACTOR;
    this._save();

    return {
      ok: true,
      phase: PHASES.REFACTOR,
      message: 'REFACTOR phase. Make structural improvements — do not change behavior. Run full suite to verify no regressions.',
    };
  }

  /**
   * Complete the cycle from REFACTOR → IDLE after a clean full-suite run.
   *
   * @param {object} testResult - Full-suite run_tests result
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  completeCycle(testResult) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.REFACTOR) {
      return { ok: false, phase: this._phase, message: `completeCycle called but phase is "${this._phase}", expected "refactor".` };
    }

    const hasRegressions = testResult && (testResult.failed > 0 || testResult.errors > 0);
    if (hasRegressions) {
      const names = (testResult.failures || []).slice(0, 3).map(f => f.name).join(', ');
      return {
        ok: false,
        phase: PHASES.REFACTOR,
        message: `Regression detected after refactor: ${testResult.failed} failing test(s)${names ? ': ' + names : ''}. Fix before completing the cycle.`,
      };
    }

    const prevTarget = this._targetTest;
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._startedAt = null;
    this._save();

    return {
      ok: true,
      phase: PHASES.IDLE,
      message: `Cycle complete for "${prevTarget}". Full suite is clean. Ready for the next cycle.`,
    };
  }

  /**
   * Skip the refactor phase and go directly back to idle from GREEN.
   * @returns {{ ok: boolean, phase: string, message: string }}
   */
  skipRefactor() {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.GREEN) {
      return { ok: false, phase: this._phase, message: `skipRefactor called but phase is "${this._phase}", expected "green".` };
    }

    const prevTarget = this._targetTest;
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._startedAt = null;
    this._save();

    return {
      ok: true,
      phase: PHASES.IDLE,
      message: `Cycle complete (refactor skipped) for "${prevTarget}". Ready for the next cycle.`,
    };
  }

  /**
   * Reset to idle unconditionally. Use if the cycle is abandoned.
   */
  reset() {
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._startedAt = null;
    this._save();
    return { ok: true, phase: PHASES.IDLE, message: 'TDD state reset to idle.' };
  }

  // ─── Phase prompt injection ─────────────────────────────────────────────────

  /**
   * Returns a brief prompt string to inject into the system context so the
   * model knows which TDD phase it's in. Returns '' in idle phase.
   */
  phasePrompt() {
    if (this.disabled || this._phase === PHASES.IDLE) return '';

    switch (this._phase) {
      case PHASES.RED:
        if (!this._redConfirmed) {
          return `\n\n[TDD: RED phase — target test: "${this._targetTest}"]\n` +
            'You MUST call run_tests first to confirm this test FAILS before writing any implementation code. ' +
            'Do NOT write implementation until red is confirmed.';
        }
        return `\n\n[TDD: RED phase (confirmed) — target test: "${this._targetTest}"]\n` +
          'The test is failing as expected. Write the MINIMUM implementation to make it pass. ' +
          'Do NOT edit the test file. Do NOT add extra logic beyond what the test requires.';

      case PHASES.GREEN:
        return `\n\n[TDD: GREEN phase — target test: "${this._targetTest}"]\n` +
          'The test is passing. Do NOT modify test files. ' +
          'You may enter REFACTOR phase or commit and call tdd_begin_cycle for the next test.';

      case PHASES.REFACTOR:
        return `\n\n[TDD: REFACTOR phase — target test: "${this._targetTest}"]\n` +
          'Make structural improvements only — no behavior changes. ' +
          'When done, call run_tests (full suite) and confirm no regressions before completing the cycle.';

      default:
        return '';
    }
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  /**
   * Returns a warning injection string if the proposed tool call violates
   * the current TDD phase rules, or null if the call is allowed.
   *
   * @param {string} toolName
   * @param {object} toolArgs
   * @returns {string|null}
   */
  checkToolCall(toolName, toolArgs) {
    if (this.disabled || this._phase === PHASES.IDLE) return null;
    const isWrite = toolName === 'write_file' || toolName === 'patch' || toolName === 'append_file' || toolName === 'read_and_patch';
    if (!isWrite) return null;

    const filePath = toolArgs && (toolArgs.path || '');
    const isTestFile = _isTestFile(filePath);

    if (this._phase === PHASES.RED && !this._redConfirmed && !isTestFile) {
      return `[TDD-GATE] You are in the RED phase but have NOT yet confirmed the test is failing. ` +
        `Call run_tests first (with test_filter "${this._targetTest}") to confirm it fails. ` +
        `Do not write implementation until you have a confirmed failing test.`;
    }

    if (this._phase === PHASES.GREEN && isTestFile) {
      return `[TDD-GATE] You are in the GREEN phase. Do NOT modify test files. ` +
        `Only edit implementation files to make "${this._targetTest}" pass. ` +
        `If you need to change the test, reset the TDD cycle first (call tdd_reset).`;
    }

    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _isTargetFailing(testResult) {
    if (!testResult) return false;
    if (testResult.exitCode !== 0) return true;
    if (testResult.failed > 0 || testResult.errors > 0) return true;
    // If filter was used, we may have no results — treat exit-code as the signal
    return false;
  }

  _isTargetPassing(testResult) {
    if (!testResult) return false;
    if (testResult.exitCode !== 0) return false;
    if (testResult.failed > 0 || testResult.errors > 0) return false;
    // If we ran with a filter and the suite was empty, that's ambiguous — require passed > 0
    if (testResult.passed === 0 && testResult.failed === 0) return false;
    return true;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  _save() {
    try {
      const dir = path.dirname(this._stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const state = {
        phase: this._phase,
        targetTest: this._targetTest,
        redConfirmed: this._redConfirmed,
        cycleId: this._cycleId,
        startedAt: this._startedAt,
        updatedAt: new Date().toISOString(),
      };
      const tmp = this._stateFile + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: FILE_MODE });
      fs.renameSync(tmp, this._stateFile);
    } catch {
      // Non-fatal — in-memory state is still correct
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this._stateFile)) return;
      const raw = fs.readFileSync(this._stateFile, 'utf-8');
      const state = JSON.parse(raw);
      if (Object.values(PHASES).includes(state.phase)) {
        this._phase = state.phase;
        this._targetTest = state.targetTest || null;
        this._redConfirmed = !!state.redConfirmed;
        this._cycleId = state.cycleId || 0;
        this._startedAt = state.startedAt || null;
      }
    } catch {
      // Corrupt state file — stay at idle
    }
  }
}

// ─── File classification ──────────────────────────────────────────────────────
// Heuristic: a file is a "test file" if its name matches common test patterns.

const TEST_FILE_PATTERNS = [
  /test_.*\.py$/i,
  /.*_test\.py$/i,
  /.*\.test\.[jt]sx?$/i,
  /.*\.spec\.[jt]sx?$/i,
  /.*_test\.go$/i,
  /.*_test\.rs$/i,
  /.*Test\.java$/i,
  /.*Spec\.java$/i,
  /.*_spec\.rb$/i,
  /.*test.*\.[jt]sx?$/i,
  /^tests?\//i,
  /\btests?\b/i,
  /__tests__/i,
  /spec\//i,
];

function _isTestFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some(re => re.test(normalized));
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance = null;

function getTDDState(options) {
  const wantedCwd = (options && options.workdir) || process.cwd();
  if (_instance && _instance.workdir === wantedCwd) return _instance;
  _instance = new TDDStateMachine({ workdir: wantedCwd, ...(options || {}) });
  return _instance;
}

function resetTDDState() {
  _instance = null;
}

module.exports = {
  TDDStateMachine,
  getTDDState,
  resetTDDState,
  PHASES,
  _isTestFile, // exported for tests
};
