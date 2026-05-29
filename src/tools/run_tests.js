// SmallCode — run_tests Compound Tool
//
// Executes the project's test suite via the auto-detected runner and returns
// a structured result object instead of raw stdout. This closes the gap where
// small models have to parse raw test output themselves — unreliable for
// framework-specific formats.
//
// Structured result shape:
//   {
//     passed:   number,
//     failed:   number,
//     errors:   number,      // distinct from failures (test errors vs assertion failures)
//     skipped:  number,
//     failures: [{ name: string, message: string }],  // per-failing-test detail
//     raw:      string,      // trimmed raw output (≤3KB) for model context
//     exitCode: number,
//     durationMs: number,
//     command:  string,      // the command that was run
//     framework: string,
//   }
//
// Test filtering (test_filter arg):
//   Maps to the framework's native pattern flag so only the named test runs.
//   Useful for the TDD red-phase confirmation: "confirm this NEW test fails."
//
//   pytest      → -k "pattern"
//   jest        → --testNamePattern "pattern"
//   vitest      → --reporter=verbose -t "pattern"
//   mocha       → --grep "pattern"
//   go test     → -run "pattern"
//   cargo test  → appended as positional arg (cargo test <pattern>)
//   node --test → --test-name-pattern "pattern"
//   rspec       → -e "pattern"
//
// Configuration:
//   Inherits SMALLCODE_TEST_RUNNER / SMALLCODE_TEST_DISABLE from TestRunnerDetector.

'use strict';

const { execSync } = require('child_process');
const { getTestRunnerDetector } = require('./test_runner');
const { sanitizeToolOutput } = require('../security/sanitize');

// ─── Filter-arg builders ──────────────────────────────────────────────────────

function buildFilterArg(framework, filter) {
  if (!filter) return '';
  const f = String(filter).trim();
  if (!f) return '';

  switch (framework) {
    case 'pytest':
    case 'hatch+pytest':
      return ` -k ${_q(f)}`;
    case 'jest':
      return ` --testNamePattern ${_q(f)}`;
    case 'vitest':
      return ` -t ${_q(f)}`;
    case 'mocha':
    case 'npm-test':
      // mocha uses --grep; npm-test may not support it, best-effort
      return ` --grep ${_q(f)}`;
    case 'go-test':
      return ` -run ${_q(f)}`;
    case 'cargo-test':
      // cargo test <pattern> — positional, no flag
      return ` ${f.replace(/[`$\\]/g, '')}`;
    case 'node-test':
      return ` --test-name-pattern ${_q(f)}`;
    case 'rspec':
      return ` -e ${_q(f)}`;
    case 'django':
      return ` ${f.replace(/[`$\\]/g, '')}`;
    default:
      return '';
  }
}

// Single-quote escape — safe on POSIX shells, avoids shell injection
function _q(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ─── Output parsers ───────────────────────────────────────────────────────────

// Each parser returns { passed, failed, errors, skipped, failures }
// `failures` is an array of { name, message } — best-effort, may be empty on
// some frameworks if output was truncated.

function parsePytest(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // Summary line: "3 passed, 1 failed, 2 errors, 4 skipped in 0.5s"
  const summaryRe = /(\d+) passed|(\d+) failed|(\d+) error(?:s)?|(\d+) skipped/gi;
  const summaryLine = output.split('\n').reverse().find(l => /passed|failed|error/i.test(l) && /in \d/.test(l));
  if (summaryLine) {
    let m;
    while ((m = summaryRe.exec(summaryLine)) !== null) {
      if (m[1]) result.passed = parseInt(m[1], 10);
      if (m[2]) result.failed = parseInt(m[2], 10);
      if (m[3]) result.errors = parseInt(m[3], 10);
      if (m[4]) result.skipped = parseInt(m[4], 10);
    }
  }

  // Per-test FAILED lines: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
  const failRe = /^FAILED\s+(\S+)\s*(?:-\s*(.+))?$/mg;
  let fm;
  while ((fm = failRe.exec(output)) !== null) {
    result.failures.push({ name: fm[1].trim(), message: (fm[2] || '').trim().slice(0, 200) });
  }

  // Error lines: "ERROR tests/test_foo.py::test_bar"
  const errRe = /^ERROR\s+(\S+)/mg;
  let em;
  while ((em = errRe.exec(output)) !== null) {
    result.failures.push({ name: em[1].trim(), message: 'test error (collection/setup/teardown)' });
  }

  return result;
}

function parseJest(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // "Tests: 1 failed, 2 passed, 3 total" or "Tests: 3 passed, 3 total"
  const testsLine = output.split('\n').find(l => /^Tests:/i.test(l.trim()));
  if (testsLine) {
    const p = testsLine.match(/(\d+) passed/); if (p) result.passed = parseInt(p[1], 10);
    const f = testsLine.match(/(\d+) failed/); if (f) result.failed = parseInt(f[1], 10);
    const s = testsLine.match(/(\d+) skipped/); if (s) result.skipped = parseInt(s[1], 10);
  }

  // "● test suite › test name" failure headers
  const failHeaderRe = /^\s*●\s+(.+)$/mg;
  let m;
  while ((m = failHeaderRe.exec(output)) !== null) {
    result.failures.push({ name: m[1].trim(), message: '' });
  }

  return result;
}

function parseVitest(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // "Tests  1 failed | 2 passed (3)" — prefer the "Tests" summary over "Test Files"
  // because "Test Files" only shows file counts, not individual test counts.
  const lines = output.split('\n');
  const testsLine = lines.find(l => /^Tests\s/i.test(l.trim()))
    || lines.find(l => /^Test Files\s/i.test(l.trim()));
  if (testsLine) {
    const p = testsLine.match(/(\d+) passed/); if (p) result.passed = parseInt(p[1], 10);
    const f = testsLine.match(/(\d+) failed/); if (f) result.failed = parseInt(f[1], 10);
    const s = testsLine.match(/(\d+) skipped/); if (s) result.skipped = parseInt(s[1], 10);
  }

  // "✗ test name" or "× test name" in verbose mode
  const failRe = /^\s*[✗×✕]\s+(.+?)(?:\s+\d+ms)?$/mg;
  let m;
  while ((m = failRe.exec(output)) !== null) {
    result.failures.push({ name: m[1].trim(), message: '' });
  }

  return result;
}

function parseGoTest(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // "--- PASS: TestName (0.00s)" and "--- FAIL: TestName (0.00s)"
  const passRe = /^--- PASS:/mg;
  const failRe = /^--- FAIL:\s+(\S+)/mg;
  const skipRe = /^--- SKIP:/mg;

  let m;
  while ((m = passRe.exec(output)) !== null) result.passed++;
  while ((m = skipRe.exec(output)) !== null) result.skipped++;
  while ((m = failRe.exec(output)) !== null) {
    result.failed++;
    // Collect indented lines after FAIL as message
    const rest = output.slice(m.index + m[0].length);
    const msgLines = [];
    for (const line of rest.split('\n').slice(1)) {
      if (!line.startsWith('\t') && !line.startsWith('    ')) break;
      msgLines.push(line.trim());
      if (msgLines.length >= 5) break;
    }
    result.failures.push({ name: m[1], message: msgLines.join(' ').slice(0, 200) });
  }

  // "FAIL\t<package>" line indicates build/compile failure
  if (result.passed === 0 && result.failed === 0 && /^FAIL\t/m.test(output)) {
    result.errors = 1;
    result.failures.push({ name: '(build failure)', message: output.split('\n').find(l => l.startsWith('#')) || 'build failed' });
  }

  return result;
}

function parseCargoTest(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // "test result: ok. 3 passed; 0 failed; 0 ignored"
  // "test result: FAILED. 1 passed; 2 failed; 0 ignored"
  const summaryRe = /test result:.*?(\d+) passed.*?(\d+) failed.*?(\d+) ignored/i;
  const sm = summaryRe.exec(output);
  if (sm) {
    result.passed = parseInt(sm[1], 10);
    result.failed = parseInt(sm[2], 10);
    result.skipped = parseInt(sm[3], 10);
  }

  // "test module::test_name ... FAILED" lines
  const failRe = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/mg;
  let m;
  while ((m = failRe.exec(output)) !== null) {
    // Find the failure message in the "failures:" section
    const nameForSearch = m[1].replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const msgMatch = new RegExp(`---- ${nameForSearch} stdout ----([\\s\\S]*?)(?=\\n---- |\\nfailures:|\n\nfailures:)`, 'i').exec(output);
    const message = msgMatch ? msgMatch[1].trim().slice(0, 200) : '';
    result.failures.push({ name: m[1], message });
  }

  return result;
}

function parseMocha(output) {
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  const passingLine = output.match(/(\d+) passing/); if (passingLine) result.passed = parseInt(passingLine[1], 10);
  const failingLine = output.match(/(\d+) failing/);  if (failingLine) result.failed = parseInt(failingLine[1], 10);
  const pendingLine = output.match(/(\d+) pending/);  if (pendingLine) result.skipped = parseInt(pendingLine[1], 10);

  // "  N) test suite title:"
  const failHeaderRe = /^\s+\d+\)\s+(.+):?\s*$/mg;
  let m;
  while ((m = failHeaderRe.exec(output)) !== null) {
    // Next non-empty line is usually the error message
    const rest = output.slice(m.index + m[0].length);
    const msgLine = rest.split('\n').find(l => l.trim().length > 0);
    result.failures.push({ name: m[1].trim(), message: (msgLine || '').trim().slice(0, 200) });
  }

  return result;
}

function parseNodeTest(output) {
  // TAP-like output from node:test
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  // "# pass N" and "# fail N"
  const passLine = output.match(/^# pass\s+(\d+)/m); if (passLine) result.passed = parseInt(passLine[1], 10);
  const failLine = output.match(/^# fail\s+(\d+)/m); if (failLine) result.failed = parseInt(failLine[1], 10);
  const skipLine = output.match(/^# skip\s+(\d+)/m); if (skipLine) result.skipped = parseInt(skipLine[1], 10);

  // "not ok N - test name"
  const notOkRe = /^not ok \d+\s*-\s*(.+)$/mg;
  let m;
  while ((m = notOkRe.exec(output)) !== null) {
    // YAML block following "not ok" has the message
    const rest = output.slice(m.index + m[0].length);
    const msgLine = rest.match(/message: (.+)/);
    result.failures.push({ name: m[1].trim(), message: (msgLine ? msgLine[1] : '').trim().slice(0, 200) });
  }

  return result;
}

function parseGeneric(output, exitCode) {
  // Last-resort heuristic: look for common pass/fail keywords
  const result = { passed: 0, failed: 0, errors: 0, skipped: 0, failures: [] };

  const passingM = output.match(/(\d+)\s+(?:tests?\s+)?(?:passed|passing|ok)\b/i);
  if (passingM) result.passed = parseInt(passingM[1], 10);

  const failingM = output.match(/(\d+)\s+(?:tests?\s+)?(?:failed|failing)\b/i);
  if (failingM) result.failed = parseInt(failingM[1], 10);

  // Heuristic: if exit code is non-zero and we couldn't detect failures, mark 1
  if (exitCode !== 0 && result.failed === 0 && result.errors === 0) {
    result.failed = 1;
    result.failures.push({ name: '(unknown)', message: output.split('\n').filter(l => l.trim()).slice(-3).join(' ').slice(0, 200) });
  }

  return result;
}

function parseOutput(framework, output, exitCode) {
  switch (framework) {
    case 'pytest':
    case 'hatch+pytest':
    case 'unittest':
    case 'django':
      return parsePytest(output);
    case 'jest':
      return parseJest(output);
    case 'vitest':
      return parseVitest(output);
    case 'go-test':
      return parseGoTest(output);
    case 'cargo-test':
      return parseCargoTest(output);
    case 'mocha':
    case 'npm-test':
      return parseMocha(output);
    case 'node-test':
      return parseNodeTest(output);
    default:
      return parseGeneric(output, exitCode);
  }
}

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Execute the test suite and return a structured result.
 *
 * @param {object} opts
 * @param {string}  [opts.test_filter]  - Optional name/pattern filter
 * @param {string}  [opts.workdir]      - Working directory (default: process.cwd())
 * @param {number}  [opts.timeout]      - Timeout in ms (default: 120000)
 * @returns {object} Structured test result
 */
function runTests(opts = {}) {
  const cwd = opts.workdir || process.cwd();
  const timeout = opts.timeout || 120000;
  const test_filter = opts.test_filter || null;

  const detector = getTestRunnerDetector({ workdir: cwd });
  const runner = detector.detect();

  if (!runner) {
    return {
      passed: 0, failed: 0, errors: 0, skipped: 0, failures: [],
      raw: 'No test runner detected. Create a pytest.ini, package.json with a test script, Cargo.toml, go.mod, etc.',
      exitCode: -1, durationMs: 0, command: null, framework: null,
      summary: 'No test runner detected.',
    };
  }

  const filterArg = buildFilterArg(runner.framework, test_filter);
  const command = runner.command + filterArg;

  const start = Date.now();
  let rawOutput = '';
  let exitCode = 0;

  try {
    rawOutput = execSync(command, {
      encoding: 'utf-8',
      timeout,
      cwd,
      maxBuffer: 2 * 1024 * 1024,
      // Merge stderr into stdout so we capture everything
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    rawOutput = (e.stdout || '') + (e.stderr || '');
    exitCode = typeof e.status === 'number' ? e.status : 1;
  }

  const durationMs = Date.now() - start;
  const raw = sanitizeToolOutput(rawOutput).slice(0, 3000);
  const parsed = parseOutput(runner.framework, rawOutput, exitCode);

  const { passed, failed, errors, skipped, failures } = parsed;

  // Build a one-line summary the model can parse at a glance
  const parts = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (errors > 0) parts.push(`${errors} errors`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const summary = parts.length > 0 ? parts.join(', ') : (exitCode === 0 ? 'all passed' : 'failed (no tests found or parse error)');

  return {
    passed,
    failed,
    errors,
    skipped,
    failures: failures.slice(0, 20), // cap to avoid overwhelming context
    raw,
    exitCode,
    durationMs,
    command,
    framework: runner.framework,
    summary,
  };
}

// ─── Formatter ────────────────────────────────────────────────────────────────
// Formats structured result as the tool's text output (the string the model sees).

function formatResult(r) {
  if (!r.command) return r.raw || 'No test runner found.';

  const lines = [];
  lines.push(`run_tests (${r.framework}): ${r.summary}  [${Math.round(r.durationMs / 100) / 10}s]`);
  lines.push(`command: ${r.command}`);

  if (r.failures.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const f of r.failures) {
      lines.push(`  ✗ ${f.name}${f.message ? ': ' + f.message : ''}`);
    }
  }

  if (r.raw) {
    lines.push('');
    lines.push('--- raw output ---');
    lines.push(r.raw);
  }

  return lines.join('\n');
}

module.exports = {
  runTests,
  formatResult,
  buildFilterArg,
  parseOutput,
  // Export individual parsers for testing
  _parsers: { parsePytest, parseJest, parseVitest, parseGoTest, parseCargoTest, parseMocha, parseNodeTest, parseGeneric },
};
