'use strict';
// Tests for the TDD harness post-write hook (_tddPostWrite).
// These verify that the loop advances automatically when files are written,
// without the model calling run_tests or tdd_begin_cycle explicitly.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { TDDStateMachine, PHASES } = require('../src/session/tdd_state');
const { TDDGovernor } = require('../src/governor/tdd_governor');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLoop(requirements = ['req1', 'req2']) {
  const stateFile = path.join(os.tmpdir(), `tdd_harness_${Math.random().toString(36).slice(2)}.json`);
  const state = new TDDStateMachine({ workdir: os.tmpdir(), stateFile });
  const gov = new TDDGovernor({ state });
  state.initRequirements(requirements);
  return { state, gov };
}

// Simulate what _tddPostWrite does, but with injected test results
// so we don't actually run a test suite.
function simulatePostWrite(state, gov, filePath, testResult) {
  const { _isTestFile } = require('../src/session/tdd_state');
  const isTestFile = _isTestFile(filePath || '');

  // Auto-begin cycle if idle + test file + failures
  if (state.isIdle() && isTestFile && (testResult.failed > 0 || testResult.errors > 0)) {
    const inferredName = (testResult.failures[0] && testResult.failures[0].name) || 'new test';
    state.beginCycle(inferredName);
  }

  return gov.processTestResult(testResult);
}

// ─── Auto-begin cycle ─────────────────────────────────────────────────────────

test('writing a failing test auto-begins the cycle (no tdd_begin_cycle needed)', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  const failingResult = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_add', message: '' }] };

  simulatePostWrite(state, gov, 'tests/test_math.py', failingResult);

  assert.equal(state.phase, PHASES.RED);
  assert.equal(state.targetTest, 'test_add');
  assert.equal(state.redConfirmed, true); // processTestResult auto-confirmed red
});

test('auto-begin does NOT fire on impl file write', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  const failingResult = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_add', message: '' }] };

  simulatePostWrite(state, gov, 'src/math.py', failingResult);

  // Did not auto-begin because src/math.py is not a test file
  assert.equal(state.phase, PHASES.IDLE);
});

// ─── Auto-advance to green ────────────────────────────────────────────────────

test('writing implementation that passes the test auto-advances to GREEN', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  const failing = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_add', message: '' }] };
  const passing = { passed: 1, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

  // Write test → auto-begin + confirm red
  simulatePostWrite(state, gov, 'tests/test_math.py', failing);
  assert.equal(state.phase, PHASES.RED);

  // Write impl → auto-advance to green
  simulatePostWrite(state, gov, 'src/math.py', passing);
  assert.equal(state.phase, PHASES.GREEN);
});

test('writing failing implementation stays in RED', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  const failing = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_add', message: '' }] };

  simulatePostWrite(state, gov, 'tests/test_math.py', failing);
  assert.equal(state.phase, PHASES.RED);

  // Impl write that still fails
  simulatePostWrite(state, gov, 'src/math.py', failing);
  assert.equal(state.phase, PHASES.RED); // still red
});

// ─── Loop auto-advance ────────────────────────────────────────────────────────

test('completing a requirement auto-advances the loop to the next one', () => {
  const { state, gov } = makeLoop(['req1', 'req2']);
  const failing = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_req1', message: '' }] };
  const passing = { passed: 1, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

  // Start req1 cycle
  simulatePostWrite(state, gov, 'tests/test_req1.py', failing);
  assert.equal(state.phase, PHASES.RED);

  // Impl passes
  simulatePostWrite(state, gov, 'src/impl.py', passing);
  assert.equal(state.phase, PHASES.GREEN);

  // Enter refactor and complete via clean suite
  state.enterRefactor();
  const cleanSuite = { passed: 2, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };
  simulatePostWrite(state, gov, 'src/impl.py', cleanSuite); // refactor edit

  // Loop should now be on req2
  assert.equal(state.doneRequirements().length, 1);
  assert.equal(state.activeRequirement().text, 'req2');
  assert.equal(state.phase, PHASES.IDLE);
});

// ─── Loop completion ──────────────────────────────────────────────────────────

test('clean full-suite run after all requirements are done completes the loop', () => {
  const { state, gov } = makeLoop(['req1']);
  const failing = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_req1', message: '' }] };
  const passing = { passed: 1, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };
  const cleanSuite = { passed: 5, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

  simulatePostWrite(state, gov, 'tests/test_req1.py', failing);
  simulatePostWrite(state, gov, 'src/impl.py', passing);
  // Skip refactor: skipRefactor() puts it back in idle with req1 done
  state.skipRefactor();

  // Now all requirements done — a clean suite write triggers loop completion
  const msg = gov.processTestResult(cleanSuite);
  assert.ok(msg);
  assert.match(msg, /COMPLETE|fulfilled/i);
  assert.ok(state.loopComplete());
});

// ─── Tool gate still enforced ─────────────────────────────────────────────────

test('harness blocks impl write before red is confirmed (gate fires)', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  // Start cycle directly (as if model called tdd_begin_cycle explicitly)
  state.beginCycle('test_add');
  // Gate should fire before red is confirmed
  const gate = gov.checkToolCall('write_file', { path: 'src/math.py' });
  assert.ok(gate);
  assert.match(gate, /TDD-GATE/);
});

test('harness blocks test file modification in GREEN phase', () => {
  const { state, gov } = makeLoop(['add returns sum']);
  const failing = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_add', message: '' }] };
  const passing = { passed: 1, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

  simulatePostWrite(state, gov, 'tests/test_math.py', failing);
  simulatePostWrite(state, gov, 'src/math.py', passing);
  assert.equal(state.phase, PHASES.GREEN);

  const gate = gov.checkToolCall('patch', { path: 'tests/test_math.py', old_str: 'x', new_str: 'y' });
  assert.ok(gate);
  assert.match(gate, /GREEN phase/);
});
