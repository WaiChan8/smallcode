// SmallCode — hybrid code search tests (issue #67)
//
// "grep on steroids": a single call that fuses exact regex/keyword matching
// with semantic ranking over a symbol-aware local index. Fully local, no
// embedding model downloads, no external services.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  hybridSearch,
  chunkFile,
  detectSymbol,
  compilePattern,
  formatResults,
} = require('../src/tools/hybrid_search');

// Build a throwaway project on disk so the search walks real files.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hybrid-'));
  fs.writeFileSync(path.join(dir, 'auth.js'), [
    '// Authentication helpers',
    'function validateToken(token) {',
    '  if (!token) return false;',
    '  return verifySignature(token);',
    '}',
    '',
    'function refreshSession(user) {',
    '  // issue a brand new session credential for the logged-in user',
    '  return createCredential(user.id);',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'math.js'), [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'function multiply(a, b) {',
    '  return a * b;',
    '}',
  ].join('\n'));
  // A directory that must be ignored.
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'function validateToken() { return 999; }');
  return dir;
}

test('detectSymbol recognizes function/class definitions', () => {
  assert.equal(detectSymbol('function validateToken(token) {'), 'validateToken');
  assert.equal(detectSymbol('class SessionManager {'), 'SessionManager');
  assert.equal(detectSymbol('const handler = (req) => {'), 'handler');
  assert.equal(detectSymbol('  return a + b;'), null);
});

test('chunkFile centers chunks on symbols', () => {
  const chunks = chunkFile('auth.js', 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}');
  const symbols = chunks.map(c => c.symbol).filter(Boolean);
  assert.ok(symbols.includes('a'));
  assert.ok(symbols.includes('b'));
});

test('compilePattern: keyword mode escapes regex metacharacters', () => {
  const re = compilePattern('a.b(c)', 'keyword');
  assert.ok(re.test('a.b(c)'));
  assert.ok(!re.test('axbxc'));   // '.' is literal, not wildcard
});

test('compilePattern: invalid regex falls back to literal', () => {
  const re = compilePattern('foo(', 'regex'); // unbalanced paren
  assert.ok(re.test('foo('));
});

test('exact regex match ranks above semantic-only and is flagged', () => {
  const dir = makeFixture();
  try {
    const results = hybridSearch('validateToken', { root: dir, mode: 'hybrid' });
    assert.ok(results.length > 0, 'should find results');
    const top = results[0];
    assert.equal(top.path, 'auth.js');
    assert.equal(top.exact, true, 'exact match flagged');
    assert.ok(top.symbol === 'validateToken' || top.snippet.includes('validateToken'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('semantic mode finds conceptually related code without exact words', () => {
  const dir = makeFixture();
  try {
    // Query words ("login credential renew") do not appear verbatim, but the
    // refreshSession chunk talks about credentials/sessions/logged-in user.
    const results = hybridSearch('renew login credential for user', { root: dir, mode: 'semantic', limit: 5 });
    assert.ok(results.length > 0, 'semantic search returns results');
    const paths = results.map(r => `${r.path}:${r.symbol}`);
    assert.ok(paths.some(p => p.includes('refreshSession')), `expected refreshSession in ${JSON.stringify(paths)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('regex mode returns only exact matches', () => {
  const dir = makeFixture();
  try {
    const results = hybridSearch('multiply', { root: dir, mode: 'regex' });
    assert.ok(results.length > 0);
    assert.ok(results.every(r => r.exact === true), 'regex mode yields only exact hits');
    assert.ok(results.every(r => r.path === 'math.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node_modules and other ignored dirs are excluded', () => {
  const dir = makeFixture();
  try {
    const results = hybridSearch('validateToken', { root: dir, mode: 'hybrid', limit: 30 });
    assert.ok(!results.some(r => r.path.includes('node_modules')), 'must not index node_modules');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('limit is respected', () => {
  const dir = makeFixture();
  try {
    const results = hybridSearch('function', { root: dir, mode: 'hybrid', limit: 2 });
    assert.ok(results.length <= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatResults renders a compact, model-friendly block', () => {
  const out = formatResults(
    [{ path: 'a.js', startLine: 1, endLine: 4, symbol: 'foo', score: 3.2, exact: true, snippet: 'function foo() {' }],
    'foo', 'hybrid'
  );
  assert.match(out, /a\.js:1/);
  assert.match(out, /foo/);
  assert.match(out, /score 3\.2/);
});

test('empty project returns no results (no crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-empty-'));
  try {
    const results = hybridSearch('anything', { root: dir });
    assert.deepEqual(results, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
