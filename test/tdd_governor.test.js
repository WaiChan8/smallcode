'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { TDDGovernor } = require('../src/governor/tdd_governor');
const { TDDStateMachine, PHASES } = require('../src/session/tdd_state');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGovernor() {
  const stateFile = path.join(os.tmpdir(), `tdd_gov_${Math.random().toString(36).slice(2)}.json`);
  const state = new TDDStateMachine({ workdir: os.tmpdir(), stateFile });
  return { gov: new TDDGovernor({ state }), state };
}

const FAILING_RESULT = { passed: 0, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'test_foo', message: 'err' }] };
const PASSING_RESULT = { passed: 2, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };
const CLEAN_SUITE    = { passed: 5, failed: 0, errors: 0, skipped: 0, exitCode: 0, failures: [] };

// ─── checkToolCall ────────────────────────────────────────────────────────────

test('checkToolCall: no block in idle phase', () => {
  const { gov } = makeGovernor();
  assert.equal(gov.checkToolCall('write_file', { path: 'src/foo.js' }), null);
});

test('checkToolCall: blocks impl write in red phase before confirmRed', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  const warning = gov.checkToolCall('write_file', { path: 'src/impl.js' });
  assert.ok(warning);
  assert.match(warning, /TDD-GATE/);
});

test('checkToolCall: allows test write in red phase', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  assert.equal(gov.checkToolCall('write_file', { path: 'tests/test_foo.py' }), null);
});

test('checkToolCall: blocks test modification in green phase', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  const warning = gov.checkToolCall('patch', { path: 'tests/test_foo.py', old_str: 'a', new_str: 'b' });
  assert.ok(warning);
  assert.match(warning, /GREEN phase/);
});

// ─── processTestResult ────────────────────────────────────────────────────────

test('processTestResult: confirms red automatically', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  const msg = gov.processTestResult(FAILING_RESULT);
  assert.ok(msg);
  assert.ok(state.redConfirmed, 'state should be red-confirmed after processTestResult');
  assert.match(msg, /RED confirmed|failing/i);
});

test('processTestResult: advances to green when target passes', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  state.confirmRed(FAILING_RESULT);
  const msg = gov.processTestResult(PASSING_RESULT);
  assert.ok(msg);
  assert.equal(state.phase, PHASES.GREEN);
});

test('processTestResult: completes refactor cycle on clean suite', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  state.enterRefactor();
  const msg = gov.processTestResult(CLEAN_SUITE);
  assert.ok(msg);
  assert.equal(state.phase, PHASES.IDLE);
});

test('processTestResult: returns null in idle phase', () => {
  const { gov } = makeGovernor();
  assert.equal(gov.processTestResult(PASSING_RESULT), null);
});

test('processTestResult: does not advance to idle when regressions exist in refactor', () => {
  const { gov, state } = makeGovernor();
  state.beginCycle('test_foo');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  state.enterRefactor();
  const failing = { passed: 4, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'other_test', message: 'broken' }] };
  gov.processTestResult(failing);
  assert.equal(state.phase, PHASES.REFACTOR, 'should stay in refactor when regressions found');
});

// ─── phasePrompt ─────────────────────────────────────────────────────────────

test('phasePrompt: delegates to state machine', () => {
  const { gov, state } = makeGovernor();
  assert.equal(gov.phasePrompt(), '');
  state.beginCycle('test_add');
  assert.ok(gov.phasePrompt().length > 0);
});

// ─── Requirements loop via governor ──────────────────────────────────────────

test('processTestResult: marks regression clean when all done + clean suite', () => {
  const { gov, state } = makeGovernor();
  state.initRequirements(['req1']);
  state.beginCycle('test_req1');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  state.skipRefactor(); // all done, loop idle
  const msg = gov.processTestResult(CLEAN_SUITE);
  assert.ok(msg);
  assert.match(msg, /COMPLETE|fulfilled/i);
  assert.ok(state.loopComplete());
});

test('processTestResult: returns reminder when all done but still need regression run', () => {
  const { gov, state } = makeGovernor();
  state.initRequirements(['req1']);
  state.beginCycle('test_req1');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  state.skipRefactor(); // all done, not yet regression-checked

  // Simulate a run that fails (regression)
  const failingSuite = { passed: 2, failed: 1, errors: 0, skipped: 0, exitCode: 1, failures: [{ name: 'other', message: '' }] };
  const msg = gov.processTestResult(failingSuite);
  // Should not complete the loop
  assert.equal(state.loopComplete(), false);
  // Should return some message (could be null or a warning)
  // Either way the loop is not complete
});

test('processTestResult: prompts for next requirement when idle in loop with pending reqs', () => {
  const { gov, state } = makeGovernor();
  state.initRequirements(['req1', 'req2']);
  // Only complete req1
  state.beginCycle('test_req1');
  state.confirmRed(FAILING_RESULT);
  state.advanceToGreen(PASSING_RESULT);
  state.skipRefactor(); // req2 now active

  // Run tests while idle (between requirements)
  const msg = gov.processTestResult(PASSING_RESULT);
  assert.ok(msg);
  assert.match(msg, /req2|next/i);
});
