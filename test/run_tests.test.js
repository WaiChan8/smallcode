'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFilterArg, parseOutput, _parsers } = require('../src/tools/run_tests');
const {
  parsePytest, parseJest, parseVitest, parseGoTest, parseCargoTest,
  parseMocha, parseNodeTest, parseGeneric,
} = _parsers;

// ─── buildFilterArg ──────────────────────────────────────────────────────────

test('buildFilterArg: pytest uses -k', () => {
  assert.equal(buildFilterArg('pytest', 'test_add'), " -k 'test_add'");
});

test('buildFilterArg: jest uses --testNamePattern', () => {
  assert.match(buildFilterArg('jest', 'adds numbers'), /--testNamePattern/);
});

test('buildFilterArg: vitest uses -t', () => {
  assert.match(buildFilterArg('vitest', 'adds numbers'), / -t /);
});

test('buildFilterArg: go-test uses -run', () => {
  assert.match(buildFilterArg('go-test', 'TestAdd'), / -run /);
});

test('buildFilterArg: cargo-test is positional', () => {
  assert.equal(buildFilterArg('cargo-test', 'test_add'), ' test_add');
});

test('buildFilterArg: node-test uses --test-name-pattern', () => {
  assert.match(buildFilterArg('node-test', 'my test'), /--test-name-pattern/);
});

test('buildFilterArg: rspec uses -e', () => {
  assert.match(buildFilterArg('rspec', 'computes sum'), / -e /);
});

test('buildFilterArg: empty filter returns empty string', () => {
  assert.equal(buildFilterArg('pytest', ''), '');
  assert.equal(buildFilterArg('pytest', null), '');
});

test('buildFilterArg: unknown framework returns empty string', () => {
  assert.equal(buildFilterArg('unknown-framework', 'test_foo'), '');
});

test('buildFilterArg: single-quotes in filter are POSIX-escaped', () => {
  const result = buildFilterArg('pytest', "it's a test");
  // POSIX shell escape for a single-quote inside single-quotes is '\''
  assert.ok(result.includes("'\\''"), 'single quote should be POSIX-escaped as \'\\\'\'');
});

// ─── parsePytest ─────────────────────────────────────────────────────────────

const PYTEST_PASS_OUTPUT = `
collected 2 items

tests/test_math.py::test_add PASSED   [ 50%]
tests/test_math.py::test_mul PASSED   [100%]

========================= 2 passed in 0.05s ==========================
`.trim();

const PYTEST_FAIL_OUTPUT = `
collected 3 items

tests/test_math.py::test_add PASSED   [ 33%]
tests/test_math.py::test_sub FAILED   [ 66%]
tests/test_math.py::test_mul PASSED   [100%]

========================= FAILURES ==========================
_________________________ test_sub _________________________

    def test_sub():
>       assert sub(3, 1) == 2
E       assert 1 == 2

tests/test_math.py:8: AssertionError
FAILED tests/test_math.py::test_sub - AssertionError: assert 1 == 2
=================== 1 failed, 2 passed in 0.10s =====================
`.trim();

test('parsePytest: all passing', () => {
  const r = parsePytest(PYTEST_PASS_OUTPUT);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.failures.length, 0);
});

test('parsePytest: one failure', () => {
  const r = parsePytest(PYTEST_FAIL_OUTPUT);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.failures.length, 1);
  assert.ok(r.failures[0].name.includes('test_sub'));
});

test('parsePytest: FAILED line captures test name', () => {
  const output = 'FAILED tests/foo.py::test_bar - AssertionError: 1 != 2\n1 failed in 0.01s';
  const r = parsePytest(output);
  assert.equal(r.failures[0].name, 'tests/foo.py::test_bar');
  assert.ok(r.failures[0].message.includes('AssertionError'));
});

test('parsePytest: errors counted separately', () => {
  const output = 'ERROR tests/foo.py::test_setup\n1 error in 0.01s';
  const r = parsePytest(output);
  assert.ok(r.failures.some(f => f.name === 'tests/foo.py::test_setup'));
});

// ─── parseJest ───────────────────────────────────────────────────────────────

const JEST_FAIL_OUTPUT = `
 FAIL  src/math.test.js
  ✓ adds 1 + 2 to equal 3 (2 ms)
  ✗ subtracts 2 - 1 to equal 1

  ● subtracts 2 - 1 to equal 1

    Expected: 1
    Received: 2

Tests: 1 failed, 1 passed, 2 total
Time:   1.234s
`.trim();

test('parseJest: counts from Tests line', () => {
  const r = parseJest(JEST_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.ok(r.failures.length > 0);
});

test('parseJest: extracts failure names from ● lines', () => {
  const r = parseJest(JEST_FAIL_OUTPUT);
  assert.ok(r.failures.some(f => f.name.includes('subtracts 2 - 1')));
});

// ─── parseVitest ─────────────────────────────────────────────────────────────

const VITEST_FAIL_OUTPUT = `
 ✓ src/math.test.js (3ms)
   ✓ adds correctly (1ms)
   × subtracts correctly (2ms)

 Test Files  1 failed (1)
 Tests  1 failed | 1 passed (2)
 Duration  320ms
`.trim();

test('parseVitest: counts from Tests line', () => {
  const r = parseVitest(VITEST_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
});

test('parseVitest: × symbol marks failures', () => {
  const r = parseVitest(VITEST_FAIL_OUTPUT);
  assert.ok(r.failures.some(f => f.name.includes('subtracts correctly')));
});

// ─── parseGoTest ─────────────────────────────────────────────────────────────

const GO_FAIL_OUTPUT = `
--- PASS: TestAdd (0.00s)
--- FAIL: TestSub (0.00s)
    math_test.go:12: expected 1 got 2
FAIL
exit status 1
FAIL\tmymodule/math\t0.004s
`.trim();

test('parseGoTest: pass and fail counts', () => {
  const r = parseGoTest(GO_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.ok(r.failures.some(f => f.name === 'TestSub'));
});

test('parseGoTest: failure message from indented lines', () => {
  const r = parseGoTest(GO_FAIL_OUTPUT);
  const sub = r.failures.find(f => f.name === 'TestSub');
  assert.ok(sub);
  assert.ok(sub.message.includes('expected 1 got 2'));
});

// ─── parseCargoTest ──────────────────────────────────────────────────────────

const CARGO_FAIL_OUTPUT = `
running 2 tests
test tests::test_add ... ok
test tests::test_sub ... FAILED

failures:

---- tests::test_sub stdout ----
thread 'tests::test_sub' panicked at 'left == right'

failures:
    tests::test_sub

test result: FAILED. 1 passed; 1 failed; 0 ignored
`.trim();

test('parseCargoTest: pass and fail counts', () => {
  const r = parseCargoTest(CARGO_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.ok(r.failures.some(f => f.name === 'tests::test_sub'));
});

// ─── parseMocha ──────────────────────────────────────────────────────────────

const MOCHA_FAIL_OUTPUT = `
  Math
    ✓ adds correctly (2ms)
    1) subtracts correctly

  1 passing (15ms)
  1 failing

  1) Math subtracts correctly:
     AssertionError: expected 2 to equal 1
`.trim();

test('parseMocha: passing and failing counts', () => {
  const r = parseMocha(MOCHA_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.ok(r.failures.length > 0);
});

// ─── parseNodeTest ───────────────────────────────────────────────────────────

const NODE_TEST_FAIL_OUTPUT = `
TAP version 13
ok 1 - adds correctly
not ok 2 - subtracts correctly
  ---
  message: Expected values to be strictly equal: 2 !== 1
  ...
1..2
# tests 2
# pass 1
# fail 1
`.trim();

test('parseNodeTest: pass and fail from TAP summary', () => {
  const r = parseNodeTest(NODE_TEST_FAIL_OUTPUT);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.ok(r.failures.some(f => f.name === 'subtracts correctly'));
});

test('parseNodeTest: failure message extracted', () => {
  const r = parseNodeTest(NODE_TEST_FAIL_OUTPUT);
  const f = r.failures.find(x => x.name === 'subtracts correctly');
  assert.ok(f);
  assert.ok(f.message.includes('2 !== 1'));
});

// ─── parseGeneric fallback ────────────────────────────────────────────────────

test('parseGeneric: non-zero exit with no known format marks 1 failed', () => {
  const r = parseGeneric('some unknown test output\ntest aborted', 1);
  assert.ok(r.failed >= 1);
  assert.ok(r.failures.length > 0);
});

test('parseGeneric: zero exit marks all passed (no-op)', () => {
  const r = parseGeneric('everything fine', 0);
  assert.equal(r.failed, 0);
  assert.equal(r.failures.length, 0);
});

// ─── parseOutput dispatch ────────────────────────────────────────────────────

test('parseOutput dispatches by framework', () => {
  const r = parseOutput('pytest', PYTEST_FAIL_OUTPUT, 1);
  assert.equal(r.failed, 1);
});

test('parseOutput: unknown framework falls back to generic', () => {
  const r = parseOutput('unknownfw', '3 passing\n1 failing', 1);
  assert.ok(r.passed >= 0);
});
