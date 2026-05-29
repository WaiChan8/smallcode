'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { TDDStateMachine, PHASES, _isTestFile } = require('../src/session/tdd_state');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(opts = {}) {
  const stateFile = path.join(os.tmpdir(), `tdd_test_${Math.random().toString(36).slice(2)}.json`);
  return new TDDStateMachine({ workdir: os.tmpdir(), stateFile, ...opts });
}

const PASSING_RESULT = { passed: 2, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };
const FAILING_RESULT = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_foo', message: 'AssertionError' }] };
const CLEAN_SUITE    = { passed: 5, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

// ─── Initial state ────────────────────────────────────────────────────────────

test('initial phase is idle', () => {
  const s = makeState();
  assert.equal(s.phase, PHASES.IDLE);
  assert.equal(s.targetTest, null);
  assert.equal(s.redConfirmed, false);
  assert.ok(s.isIdle());
});

// ─── beginCycle ───────────────────────────────────────────────────────────────

test('beginCycle transitions to red', () => {
  const s = makeState();
  const r = s.beginCycle('test_add');
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.RED);
  assert.equal(s.targetTest, 'test_add');
  assert.equal(s.redConfirmed, false);
});

test('beginCycle trims whitespace from test name', () => {
  const s = makeState();
  s.beginCycle('  test_add  ');
  assert.equal(s.targetTest, 'test_add');
});

test('beginCycle rejects empty test name', () => {
  const s = makeState();
  const r = s.beginCycle('');
  assert.equal(r.ok, false);
  assert.equal(s.phase, PHASES.IDLE);
});

test('beginCycle rejects null test name', () => {
  const s = makeState();
  const r = s.beginCycle(null);
  assert.equal(r.ok, false);
});

// ─── confirmRed ───────────────────────────────────────────────────────────────

test('confirmRed marks red as confirmed when tests fail', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const r = s.confirmRed(FAILING_RESULT);
  assert.equal(r.ok, true);
  assert.equal(s.redConfirmed, true);
  assert.equal(s.phase, PHASES.RED);
});

test('confirmRed rejects when all tests pass', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const r = s.confirmRed(PASSING_RESULT);
  assert.equal(r.ok, false);
  assert.equal(s.redConfirmed, false);
});

test('confirmRed fails when called outside red phase', () => {
  const s = makeState();
  const r = s.confirmRed(FAILING_RESULT);
  assert.equal(r.ok, false);
});

// ─── advanceToGreen ───────────────────────────────────────────────────────────

test('advanceToGreen transitions red→green when tests pass', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  const r = s.advanceToGreen(PASSING_RESULT);
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.GREEN);
});

test('advanceToGreen blocked without confirmRed', () => {
  const s = makeState();
  s.beginCycle('test_add');
  // Skip confirmRed
  const r = s.advanceToGreen(PASSING_RESULT);
  assert.equal(r.ok, false);
  assert.equal(s.phase, PHASES.RED);
  assert.match(r.message, /red phase not confirmed/i);
});

test('advanceToGreen blocked when tests still fail', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  const r = s.advanceToGreen(FAILING_RESULT);
  assert.equal(r.ok, false);
  assert.equal(s.phase, PHASES.RED);
});

test('advanceToGreen blocked when no tests ran (passed=0, failed=0)', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  const r = s.advanceToGreen({ passed: 0, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] });
  assert.equal(r.ok, false);
});

// ─── enterRefactor ────────────────────────────────────────────────────────────

test('enterRefactor transitions green→refactor', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  const r = s.enterRefactor();
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.REFACTOR);
});

test('enterRefactor blocked outside green phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const r = s.enterRefactor();
  assert.equal(r.ok, false);
});

// ─── completeCycle ────────────────────────────────────────────────────────────

test('completeCycle returns to idle after clean suite', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  s.enterRefactor();
  const r = s.completeCycle(CLEAN_SUITE);
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.IDLE);
  assert.equal(s.targetTest, null);
});

test('completeCycle blocked when regressions exist', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  s.enterRefactor();
  const r = s.completeCycle({ passed: 4, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_other', message: 'broke it' }] });
  assert.equal(r.ok, false);
  assert.equal(s.phase, PHASES.REFACTOR);
  assert.match(r.message, /regression/i);
});

test('completeCycle blocked outside refactor phase', () => {
  const s = makeState();
  const r = s.completeCycle(CLEAN_SUITE);
  assert.equal(r.ok, false);
});

// ─── skipRefactor ─────────────────────────────────────────────────────────────

test('skipRefactor transitions green→idle directly', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  const r = s.skipRefactor();
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.IDLE);
  assert.equal(s.targetTest, null);
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('reset returns to idle from any phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  const r = s.reset();
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.IDLE);
  assert.equal(s.targetTest, null);
  assert.equal(s.redConfirmed, false);
});

// ─── checkToolCall ────────────────────────────────────────────────────────────

test('checkToolCall: no gate fires in idle phase', () => {
  const s = makeState();
  assert.equal(s.checkToolCall('write_file', { path: 'src/foo.js' }), null);
});

test('checkToolCall: gate fires for impl write in red phase before confirmRed', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const warning = s.checkToolCall('write_file', { path: 'src/math.js' });
  assert.ok(warning);
  assert.match(warning, /RED phase/i);
  assert.match(warning, /TDD-GATE/);
});

test('checkToolCall: no gate for test file write in red phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const warning = s.checkToolCall('write_file', { path: 'test/test_math.py' });
  assert.equal(warning, null);
});

test('checkToolCall: no gate for impl write in red phase AFTER confirmRed', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  const warning = s.checkToolCall('write_file', { path: 'src/math.js' });
  assert.equal(warning, null);
});

test('checkToolCall: gate fires for test file modification in green phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  const warning = s.checkToolCall('patch', { path: 'tests/test_math.py', old_str: 'x', new_str: 'y' });
  assert.ok(warning);
  assert.match(warning, /GREEN phase/i);
});

test('checkToolCall: no gate for impl patch in green phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  const warning = s.checkToolCall('patch', { path: 'src/math.js', old_str: 'x', new_str: 'y' });
  assert.equal(warning, null);
});

test('checkToolCall: non-write tools never trigger gate', () => {
  const s = makeState();
  s.beginCycle('test_add');
  assert.equal(s.checkToolCall('bash', { command: 'ls' }), null);
  assert.equal(s.checkToolCall('read_file', { path: 'src/foo.js' }), null);
});

// ─── phasePrompt ─────────────────────────────────────────────────────────────

test('phasePrompt returns empty string in idle phase', () => {
  const s = makeState();
  assert.equal(s.phasePrompt(), '');
});

test('phasePrompt returns non-empty string in red phase', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const prompt = s.phasePrompt();
  assert.ok(prompt.length > 0);
  assert.match(prompt, /RED/);
  assert.match(prompt, /test_add/);
});

test('phasePrompt changes after confirmRed', () => {
  const s = makeState();
  s.beginCycle('test_add');
  const before = s.phasePrompt();
  s.confirmRed(FAILING_RESULT);
  const after = s.phasePrompt();
  // Both reference RED but the wording should differ
  assert.notEqual(before, after);
});

test('phasePrompt: GREEN phase message mentions not modifying tests', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  assert.match(s.phasePrompt(), /GREEN/);
  assert.match(s.phasePrompt(), /test files/i);
});

test('phasePrompt: REFACTOR mentions no behavior changes', () => {
  const s = makeState();
  s.beginCycle('test_add');
  s.confirmRed(FAILING_RESULT);
  s.advanceToGreen(PASSING_RESULT);
  s.enterRefactor();
  assert.match(s.phasePrompt(), /REFACTOR/);
});

// ─── disabled mode ────────────────────────────────────────────────────────────

test('disabled machine allows all tool calls and transitions trivially', () => {
  const s = makeState({ disable: true });
  const r = s.beginCycle('test_foo');
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASES.IDLE); // stays idle when disabled
  assert.equal(s.checkToolCall('write_file', { path: 'src/impl.js' }), null);
});

// ─── persistence ─────────────────────────────────────────────────────────────

test('state persists to disk and reloads', () => {
  const stateFile = path.join(os.tmpdir(), `tdd_persist_${Math.random().toString(36).slice(2)}.json`);
  const s1 = new TDDStateMachine({ workdir: os.tmpdir(), stateFile });
  s1.beginCycle('test_foo');
  s1.confirmRed(FAILING_RESULT);

  // Create a second instance from the same file
  const s2 = new TDDStateMachine({ workdir: os.tmpdir(), stateFile });
  assert.equal(s2.phase, PHASES.RED);
  assert.equal(s2.targetTest, 'test_foo');
  assert.equal(s2.redConfirmed, true);

  // Cleanup
  try { fs.unlinkSync(stateFile); } catch {}
});

test('corrupt state file is handled gracefully (stays idle)', () => {
  const stateFile = path.join(os.tmpdir(), `tdd_corrupt_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(stateFile, 'NOT JSON {{{');
  const s = new TDDStateMachine({ workdir: os.tmpdir(), stateFile });
  assert.equal(s.phase, PHASES.IDLE);
  try { fs.unlinkSync(stateFile); } catch {}
});

// ─── _isTestFile ─────────────────────────────────────────────────────────────

test('_isTestFile: recognizes pytest naming', () => {
  assert.ok(_isTestFile('test_math.py'));
  assert.ok(_isTestFile('tests/test_math.py'));
  assert.ok(_isTestFile('math_test.py'));
});

test('_isTestFile: recognizes Jest/Vitest naming', () => {
  assert.ok(_isTestFile('math.test.js'));
  assert.ok(_isTestFile('math.test.ts'));
  assert.ok(_isTestFile('math.spec.js'));
  assert.ok(_isTestFile('src/__tests__/math.js'));
});

test('_isTestFile: recognizes Go test naming', () => {
  assert.ok(_isTestFile('math_test.go'));
});

test('_isTestFile: recognizes Rust test naming', () => {
  assert.ok(_isTestFile('math_test.rs'));
});

test('_isTestFile: regular impl files are not test files', () => {
  assert.ok(!_isTestFile('src/math.js'));
  assert.ok(!_isTestFile('lib/utils.py'));
  assert.ok(!_isTestFile('main.go'));
  assert.ok(!_isTestFile('src/lib.rs'));
});

test('_isTestFile: empty path returns false', () => {
  assert.ok(!_isTestFile(''));
  assert.ok(!_isTestFile(null));
});

// ─── Full cycle integration ───────────────────────────────────────────────────

test('full Red→Green→Refactor→Idle cycle completes cleanly', () => {
  const s = makeState();

  // Start cycle
  assert.equal(s.beginCycle('test_add').ok, true);
  assert.equal(s.phase, PHASES.RED);

  // Confirm red
  assert.equal(s.confirmRed(FAILING_RESULT).ok, true);
  assert.equal(s.redConfirmed, true);

  // Advance to green
  assert.equal(s.advanceToGreen(PASSING_RESULT).ok, true);
  assert.equal(s.phase, PHASES.GREEN);

  // Enter refactor
  assert.equal(s.enterRefactor().ok, true);
  assert.equal(s.phase, PHASES.REFACTOR);

  // Complete cycle
  assert.equal(s.completeCycle(CLEAN_SUITE).ok, true);
  assert.equal(s.phase, PHASES.IDLE);
  assert.equal(s.targetTest, null);
});
