// SmallCode — TDD State Machine
//
// Tracks the Red → Green → Refactor cycle and — when a requirements list is
// provided — loops through every requirement until all have passing tests.
//
// Two modes of operation:
//
//   Single-cycle mode  — call beginCycle(testName) directly.
//                        Works as before: one cycle, then idle.
//
//   Loop mode          — call initRequirements(list) first, then the machine
//                        automatically advances to the next pending requirement
//                        after each completeCycle()/skipRefactor(). The loop
//                        ends only when all requirements have passing tests AND
//                        a clean full-suite regression run passes.
//
// Phase model (same for both modes):
//
//   idle      No cycle in progress. Loop mode: may still have pending requirements.
//   red       Test written; agent MUST confirm it fails before writing impl.
//   green     Target test passes. Agent must not modify test files.
//   refactor  Structural cleanup. Clean full-suite run required to finish.
//
// Transitions:
//
//   any ──initRequirements(list)──►  idle (requirements registered, loop armed)
//   idle ──beginCycle(name)──►       red
//   red  ──confirmRed(result)──►     red (confirmed=true)
//   red  ──advanceToGreen(result)──► green  (requires confirmRed)
//   green ──enterRefactor()──►       refactor
//   refactor ──completeCycle(r)──►   idle or red (next req, loop mode)
//   green ──skipRefactor()──►        idle or red (next req, loop mode)
//   any  ──reset()──►                idle (clears requirements too)
//
// Requirement statuses: 'pending' | 'active' | 'done'
//
// Loop completion:  allRequirementsDone() + a clean full-suite run (tracked
//                   via markRegressionClean() called by the governor).
//
// Persistence: .smallcode/tdd_state.json — survives session restarts.
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

const REQ_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
});

const FILE_MODE = 0o600;

class TDDStateMachine {
  constructor(options = {}) {
    this.workdir = options.workdir || process.cwd();
    this.disabled = options.disable || process.env.SMALLCODE_TDD === 'false';
    this._stateFile = options.stateFile
      || path.join(this.workdir, '.smallcode', 'tdd_state.json');

    // Single-cycle state
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._cycleId = 0;
    this._startedAt = null;

    // Loop state
    this._requirements = [];      // [{ id, text, status }]
    this._loopActive = false;     // true when initRequirements() was called
    this._regressionClean = false; // true when a clean full-suite run has been confirmed

    if (!this.disabled) {
      this._load();
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get phase() { return this._phase; }
  get targetTest() { return this._targetTest; }
  get redConfirmed() { return this._redConfirmed; }
  get requirements() { return this._requirements; }
  get loopActive() { return this._loopActive; }

  isIdle()     { return this._phase === PHASES.IDLE; }
  isRed()      { return this._phase === PHASES.RED; }
  isGreen()    { return this._phase === PHASES.GREEN; }
  isRefactor() { return this._phase === PHASES.REFACTOR; }
  isActive()   { return this._phase !== PHASES.IDLE; }

  pendingRequirements() { return this._requirements.filter(r => r.status === REQ_STATUS.PENDING); }
  doneRequirements()    { return this._requirements.filter(r => r.status === REQ_STATUS.DONE); }
  activeRequirement()   { return this._requirements.find(r => r.status === REQ_STATUS.ACTIVE) || null; }

  /** True when every requirement is done. Does NOT include the regression check. */
  allRequirementsDone() {
    return this._loopActive
      && this._requirements.length > 0
      && this._requirements.every(r => r.status === REQ_STATUS.DONE);
  }

  /** True when all requirements are done AND a clean full-suite run was confirmed. */
  loopComplete() {
    return this.allRequirementsDone() && this._regressionClean;
  }

  // ─── Requirements loop ─────────────────────────────────────────────────────

  /**
   * Arm the loop with a list of requirements.
   * Each entry is a plain-English description of behaviour to implement.
   * Does not start a cycle — call beginCycle() or let the governor auto-start.
   *
   * @param {string[]} requirements
   * @returns {{ ok: boolean, message: string, requirements: object[] }}
   */
  initRequirements(requirements) {
    if (this.disabled) return { ok: true, message: 'TDD gating disabled.', requirements: [] };
    if (!Array.isArray(requirements) || requirements.length === 0) {
      return { ok: false, message: 'initRequirements: pass a non-empty array of requirement strings.' };
    }

    this._requirements = requirements
      .map((text, i) => String(text || '').trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `r${String(i + 1).padStart(2, '0')}`, text, status: REQ_STATUS.PENDING }));

    if (this._requirements.length === 0) {
      return { ok: false, message: 'initRequirements: all requirement strings were empty.' };
    }

    this._loopActive = true;
    this._regressionClean = false;
    // Reset any in-flight cycle
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._save();

    const lines = this._requirements.map(r => `  ○ ${r.id}: ${r.text}`).join('\n');
    return {
      ok: true,
      message: `TDD loop initialised with ${this._requirements.length} requirement(s):\n${lines}\n\nNext: write a failing test for "${this._requirements[0].text}", then call tdd_begin_cycle.`,
      requirements: this._requirements,
    };
  }

  /**
   * Mark a requirement as complete (used internally after a cycle reaches green).
   * If loopActive, auto-starts the next pending requirement's cycle.
   *
   * @param {string} reqId
   * @returns {{ ok: boolean, advanced: boolean, next: object|null, message: string }}
   */
  _completeRequirement(reqId) {
    const req = this._requirements.find(r => r.id === reqId);
    if (!req) return { ok: false, advanced: false, next: null, message: `Requirement ${reqId} not found.` };

    req.status = REQ_STATUS.DONE;
    this._save();

    const next = this._requirements.find(r => r.status === REQ_STATUS.PENDING);
    if (next) {
      next.status = REQ_STATUS.ACTIVE;
      this._save();
      return {
        ok: true,
        advanced: true,
        next,
        message: `✓ "${req.text}" done. Moving to next: "${next.text}" (${next.id}).`,
      };
    }

    const done = this.doneRequirements().length;
    const total = this._requirements.length;
    return {
      ok: true,
      advanced: false,
      next: null,
      message: `✓ All ${total} requirement(s) implemented. Run run_tests (full suite) to confirm no regressions, then the loop is complete.`,
    };
  }

  /**
   * Mark that a clean full-suite run was observed. Only meaningful after
   * allRequirementsDone() is true. Called by the governor.
   */
  markRegressionClean() {
    if (!this.allRequirementsDone()) return false;
    this._regressionClean = true;
    this._save();
    return true;
  }

  // ─── Single-cycle transitions ───────────────────────────────────────────────

  /**
   * Start a TDD cycle for testName. In loop mode, also links the cycle to
   * the currently-active requirement (or the first pending one if none active).
   */
  beginCycle(testName) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (!testName || typeof testName !== 'string' || !testName.trim()) {
      return { ok: false, phase: this._phase, message: 'beginCycle requires a non-empty testName.' };
    }

    // In loop mode, mark the associated requirement as active
    if (this._loopActive) {
      const activeReq = this.activeRequirement();
      if (!activeReq) {
        // Try to activate the first pending requirement
        const first = this._requirements.find(r => r.status === REQ_STATUS.PENDING);
        if (first) first.status = REQ_STATUS.ACTIVE;
      }
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
      message: `TDD cycle started for "${this._targetTest}". Call run_tests (with test_filter "${this._targetTest}") to confirm it fails (RED phase).`,
    };
  }

  confirmRed(testResult) {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.RED) {
      return { ok: false, phase: this._phase, message: `confirmRed called but phase is "${this._phase}", expected "red".` };
    }

    if (!this._isTargetFailing(testResult) && testResult && testResult.failed === 0 && testResult.exitCode === 0) {
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
      message: `RED confirmed: "${this._targetTest}" is failing. Now write the minimum implementation to make it pass.`,
    };
  }

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

    if (!this._isTargetPassing(testResult)) {
      return {
        ok: false,
        phase: PHASES.RED,
        message: `"${this._targetTest}" is still failing. Fix the implementation, then call run_tests again.`,
      };
    }

    this._phase = PHASES.GREEN;
    this._save();

    const loopHint = this._loopActive
      ? ' Call tdd_advance (or skip to next requirement via tdd_advance with skip_refactor=true).'
      : ' Enter REFACTOR or start the next cycle.';

    return {
      ok: true,
      phase: PHASES.GREEN,
      message: `GREEN: "${this._targetTest}" is now passing.${loopHint}`,
    };
  }

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
      message: 'REFACTOR: make structural improvements only. Run full suite to verify no regressions.',
    };
  }

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
        message: `Regression: ${testResult.failed} failing test(s)${names ? ': ' + names : ''}. Fix before completing the cycle.`,
      };
    }

    return this._finishCycle('refactor', testResult);
  }

  skipRefactor() {
    if (this.disabled) return { ok: true, phase: 'idle', message: 'TDD gating disabled.' };
    if (this._phase !== PHASES.GREEN) {
      return { ok: false, phase: this._phase, message: `skipRefactor called but phase is "${this._phase}", expected "green".` };
    }
    return this._finishCycle('green', null);
  }

  reset() {
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._startedAt = null;
    this._requirements = [];
    this._loopActive = false;
    this._regressionClean = false;
    this._save();
    return { ok: true, phase: PHASES.IDLE, message: 'TDD state reset to idle.' };
  }

  // ─── Phase prompt injection ─────────────────────────────────────────────────

  phasePrompt() {
    if (this.disabled) return '';

    const reqProgress = this._loopActive && this._requirements.length > 0
      ? this._formatRequirementsChecklist()
      : '';

    if (this._phase === PHASES.IDLE) {
      if (!this._loopActive || this._requirements.length === 0) return '';
      if (this.loopComplete()) {
        return `\n\n[TDD LOOP: COMPLETE — all ${this._requirements.length} requirements fulfilled]\n${reqProgress}`;
      }
      if (this.allRequirementsDone()) {
        return `\n\n[TDD LOOP: all tests green — run run_tests (full suite) to confirm no regressions]\n${reqProgress}`;
      }
      // There is an active requirement waiting for a cycle to begin
      const active = this.activeRequirement();
      const current = active || this.pendingRequirements()[0];
      const nextText = current ? `"${current.text}"` : 'the next requirement';
      return `\n\n[TDD LOOP: ${this.doneRequirements().length}/${this._requirements.length} done — idle]\n${reqProgress}\nNext: write a failing test for ${nextText}, then call tdd_begin_cycle.`;
    }

    const header = this._loopActive
      ? `[TDD LOOP: ${this.doneRequirements().length}/${this._requirements.length} done — ${this._phase.toUpperCase()} phase]`
      : `[TDD: ${this._phase.toUpperCase()} phase]`;

    let body = '';
    switch (this._phase) {
      case PHASES.RED:
        body = !this._redConfirmed
          ? `Target test: "${this._targetTest}"\nYou MUST call run_tests (test_filter="${this._targetTest}") to confirm it FAILS before writing implementation.`
          : `Target test: "${this._targetTest}" — RED confirmed.\nWrite the MINIMUM implementation to make it pass. Do NOT edit the test file.`;
        break;
      case PHASES.GREEN:
        body = `Target test: "${this._targetTest}" is passing.\nDo NOT modify test files. Call tdd_advance to enter REFACTOR or skip to the next requirement.`;
        break;
      case PHASES.REFACTOR:
        body = `Target test: "${this._targetTest}"\nStructural cleanup only. Call run_tests (full suite) then tdd_advance to complete this requirement.`;
        break;
    }

    return `\n\n${header}\n${reqProgress ? reqProgress + '\n' : ''}${body}`;
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  checkToolCall(toolName, toolArgs) {
    if (this.disabled || this._phase === PHASES.IDLE) return null;
    const isWrite = toolName === 'write_file' || toolName === 'patch'
      || toolName === 'append_file' || toolName === 'read_and_patch';
    if (!isWrite) return null;

    const filePath = toolArgs && (toolArgs.path || '');
    const isTestFile = _isTestFile(filePath);

    if (this._phase === PHASES.RED && !this._redConfirmed && !isTestFile) {
      return `[TDD-GATE] RED phase — NOT YET confirmed red. Call run_tests (test_filter="${this._targetTest}") first to confirm this test fails. Do not write implementation yet.`;
    }

    if (this._phase === PHASES.GREEN && isTestFile) {
      return `[TDD-GATE] GREEN phase — do NOT modify test files. Edit only implementation files. To change the test, call tdd_reset and start a new cycle.`;
    }

    return null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _finishCycle(fromPhase, testResult) {
    const prevTarget = this._targetTest;
    this._phase = PHASES.IDLE;
    this._targetTest = null;
    this._redConfirmed = false;
    this._startedAt = null;

    // In loop mode: find which requirement this cycle was for, mark it done,
    // and auto-advance to the next one.
    if (this._loopActive) {
      const activeReq = this.activeRequirement();
      if (activeReq) {
        const loopResult = this._completeRequirement(activeReq.id);
        this._save();

        if (loopResult.next) {
          // Auto-begin next cycle in the state machine (but don't write tests —
          // that's the model's job; we just advance the loop pointer).
          return {
            ok: true,
            phase: PHASES.IDLE,
            loopAdvanced: true,
            nextRequirement: loopResult.next,
            message: `${loopResult.message}\n\nNext action: write a failing test for "${loopResult.next.text}", then call tdd_begin_cycle.`,
          };
        }

        // All requirements done — check regression
        this._save();
        return {
          ok: true,
          phase: PHASES.IDLE,
          loopAdvanced: false,
          allDone: true,
          message: `${loopResult.message}`,
        };
      }
    }

    // Single-cycle mode
    this._save();
    return {
      ok: true,
      phase: PHASES.IDLE,
      message: `Cycle complete (${fromPhase}) for "${prevTarget}". Ready for the next cycle.`,
    };
  }

  _isTargetFailing(testResult) {
    if (!testResult) return false;
    if (testResult.exitCode !== 0) return true;
    if (testResult.failed > 0 || testResult.errors > 0) return true;
    return false;
  }

  _isTargetPassing(testResult) {
    if (!testResult) return false;
    if (testResult.exitCode !== 0) return false;
    if (testResult.failed > 0 || testResult.errors > 0) return false;
    if (testResult.passed === 0 && testResult.failed === 0) return false;
    return true;
  }

  _formatRequirementsChecklist() {
    if (this._requirements.length === 0) return '';
    return this._requirements.map(r => {
      const mark = r.status === REQ_STATUS.DONE ? '✓' : r.status === REQ_STATUS.ACTIVE ? '→' : '○';
      return `  ${mark} ${r.id}: ${r.text}`;
    }).join('\n');
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
        requirements: this._requirements,
        loopActive: this._loopActive,
        regressionClean: this._regressionClean,
        updatedAt: new Date().toISOString(),
      };
      const tmp = this._stateFile + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: FILE_MODE });
      fs.renameSync(tmp, this._stateFile);
    } catch {
      // Non-fatal
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
        this._requirements = Array.isArray(state.requirements) ? state.requirements : [];
        this._loopActive = !!state.loopActive;
        this._regressionClean = !!state.regressionClean;
      }
    } catch {
      // Corrupt state file — stay at idle
    }
  }
}

// ─── File classification ──────────────────────────────────────────────────────

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

function resetTDDState() { _instance = null; }

module.exports = {
  TDDStateMachine,
  getTDDState,
  resetTDDState,
  PHASES,
  REQ_STATUS,
  _isTestFile,
};
