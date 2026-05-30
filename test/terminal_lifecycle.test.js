// SmallCode — terminal lifecycle tests (issue #71)
//
// The fullscreen TUI enables raw mode + SGR mouse tracking + bracketed paste.
// If the process is suspended (Ctrl+Z), terminated, or crashes without going
// through leave(), those modes leak into the shell and it starts echoing raw
// mouse escape sequences (e.g. "0;66;42M"). TerminalController must ALWAYS
// restore the terminal on every exit path.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { TerminalController } = require('../src/tui/terminal.js');

// Build a controller wired to fake stdout/stdin so the test runner's real
// terminal is never touched. `reRaise` is stubbed so we never actually stop
// or kill the test process.
function makeController(extra = {}) {
  let out = '';
  const raised = [];
  const stdout = { isTTY: true, write: (s) => { out += s; return true; }, on: () => {} };
  const rawModeCalls = [];
  const stdin = {
    isTTY: true,
    setRawMode: (v) => { rawModeCalls.push(v); },
    resume: () => {},
    pause: () => {},
    on: () => {},
  };
  const ctrl = new TerminalController({
    stdout,
    stdin,
    reRaise: (sig) => raised.push(sig),
    ...extra,
  });
  return {
    ctrl,
    raised,
    rawModeCalls,
    get out() { return out; },
    clear() { out = ''; },
  };
}

// Restoration must turn OFF mouse tracking, bracketed paste, alt buffer, and
// re-show the cursor.
function assertRestored(out) {
  assert.match(out, /\x1b\[\?1000l/, 'mouse button tracking disabled');
  assert.match(out, /\x1b\[\?1006l/, 'SGR mouse encoding disabled');
  assert.match(out, /\x1b\[\?2004l/, 'bracketed paste disabled');
  assert.match(out, /\x1b\[\?1049l/, 'left alternate buffer');
  assert.match(out, /\x1b\[\?25h/, 'cursor shown');
}

test('enter() enables raw mode, mouse tracking and bracketed paste', () => {
  const h = makeController();
  h.ctrl.enter();
  assert.match(h.out, /\x1b\[\?1049h/, 'entered alternate buffer');
  assert.match(h.out, /\x1b\[\?1000h/, 'mouse tracking enabled');
  assert.match(h.out, /\x1b\[\?1006h/, 'SGR encoding enabled');
  assert.match(h.out, /\x1b\[\?2004h/, 'bracketed paste enabled');
  assert.deepEqual(h.rawModeCalls, [true]);
  assert.equal(h.ctrl.active, true);
  h.ctrl.leave();
});

test('leave() restores the terminal', () => {
  const h = makeController();
  h.ctrl.enter();
  h.clear();
  h.ctrl.leave();
  assertRestored(h.out);
  assert.deepEqual(h.rawModeCalls, [true, false]);
  assert.equal(h.ctrl.active, false);
});

test('suspend() restores the terminal before re-raising the stop signal (issue #71)', () => {
  const h = makeController();
  h.ctrl.enter();
  h.clear();
  h.ctrl.suspend('SIGTSTP');
  // Terminal must be clean BEFORE the process is actually stopped, otherwise
  // the shell shows leaked mouse sequences.
  assertRestored(h.out);
  assert.deepEqual(h.raised, ['SIGTSTP'], 're-raised stop signal for default disposition');
});

test('resume() re-enters TUI mode and redraws', () => {
  const h = makeController();
  let redrawn = 0;
  h.ctrl._onResume = () => { redrawn++; };
  h.ctrl.enter();
  h.ctrl.suspend('SIGTSTP');
  h.clear();
  h.ctrl.resume();
  assert.match(h.out, /\x1b\[\?1049h/, 're-entered alternate buffer');
  assert.match(h.out, /\x1b\[\?1000h/, 're-enabled mouse tracking');
  assert.equal(redrawn, 1, 'redraw callback fired on resume');
});

test('suspend is a no-op when not active or already suspended', () => {
  const h = makeController();
  h.ctrl.suspend('SIGTSTP');           // not active yet
  assert.deepEqual(h.raised, []);
  h.ctrl.enter();
  h.ctrl.suspend('SIGTSTP');
  h.ctrl.suspend('SIGTSTP');           // second call ignored
  assert.deepEqual(h.raised, ['SIGTSTP']);
});

test('uncaughtException handler restores the terminal then exits', () => {
  const h = makeController();
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    h.ctrl.enter();
    h.clear();
    h.ctrl._handleUncaught(new Error('boom'));
    assertRestored(h.out);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});

test('terminate handler restores the terminal then re-raises the signal', () => {
  const h = makeController();
  h.ctrl.enter();
  h.clear();
  h.ctrl._handleTerminate('SIGTERM');
  assertRestored(h.out);
  assert.deepEqual(h.raised, ['SIGTERM']);
  assert.equal(h.ctrl.active, false);
});

test('leave() removes process listeners (no leak across enter/leave cycles)', () => {
  const h = makeController();
  const before = process.listenerCount('uncaughtException');
  h.ctrl.enter();
  assert.equal(process.listenerCount('uncaughtException'), before + 1);
  h.ctrl.leave();
  assert.equal(process.listenerCount('uncaughtException'), before, 'listener removed on leave');
});

test('double enter() is idempotent', () => {
  const h = makeController();
  const before = process.listenerCount('exit');
  h.ctrl.enter();
  h.ctrl.enter();
  assert.equal(process.listenerCount('exit'), before + 1, 'handlers installed once');
  h.ctrl.leave();
});
