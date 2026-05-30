// SmallCode — Terminal Lifecycle Controller
// Centralizes alternate-buffer / raw-mode / mouse-tracking / bracketed-paste
// setup and *guaranteed* teardown.
//
// Why this exists (issue #71): the fullscreen TUI enables raw mode + SGR mouse
// tracking (\x1b[?1000h \x1b[?1006h) + bracketed paste (\x1b[?2004h). If the
// process is suspended (Ctrl+Z / SIGTSTP), backgrounded (SIGTTIN / SIGTTOU),
// terminated (SIGTERM / SIGHUP) or crashes (uncaughtException) without going
// through the normal leave() path, those modes are never disabled and the shell
// is left echoing raw mouse escape sequences (e.g. "0;66;42M") with a broken,
// invisible cursor.
//
// This controller installs process-level guards so the terminal is ALWAYS
// restored. On resume (SIGCONT) it re-enters TUI mode and asks the owner to
// redraw, so Ctrl+Z → fg works seamlessly.

'use strict';

// Raw control sequences this controller owns. Kept self-contained so the
// terminal lifecycle has no dependency on the renderer.
const SEQ = {
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  reset: '\x1b[0m',
  mouseOn: '\x1b[?1000h\x1b[?1006h',   // button tracking + SGR encoding
  mouseOff: '\x1b[?1000l\x1b[?1006l',
  pasteOn: '\x1b[?2004h',              // bracketed paste
  pasteOff: '\x1b[?2004l',
};

// Job-control signals that suspend the process. Only meaningful on POSIX.
const STOP_SIGNALS = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU'];
// Signals that should terminate the process after restoring the terminal.
const TERM_SIGNALS = ['SIGTERM', 'SIGHUP'];
const IS_POSIX = process.platform !== 'win32';

class TerminalController {
  constructor(options = {}) {
    this._stdout = options.stdout || process.stdout;
    this._stdin = options.stdin || process.stdin;
    this._onResume = typeof options.onResume === 'function' ? options.onResume : () => {};
    // Injectable for tests so we don't actually stop/kill the test runner.
    this._reRaise = options.reRaise || ((sig) => { try { process.kill(process.pid, sig); } catch { /* noop */ } });

    this._rawWrite = this._stdout.write.bind(this._stdout);
    this._active = false;
    this._suspended = false;
    this._installed = false;

    // Pre-bind handlers so they can be removed individually.
    this._stopHandlers = {};
    for (const sig of STOP_SIGNALS) this._stopHandlers[sig] = () => this.suspend(sig);
    this._contHandler = () => this.resume();
    this._termHandlers = {};
    for (const sig of TERM_SIGNALS) this._termHandlers[sig] = () => this._handleTerminate(sig);
    this._exitHandler = () => { if (this._active) this._disengage(); };
    this._uncaughtHandler = (err) => this._handleUncaught(err);
  }

  get active() { return this._active; }
  get rawWrite() { return this._rawWrite; }

  // ─── Mode toggles ────────────────────────────────────────────────────

  // Put the terminal into TUI mode (alt buffer, hidden cursor, raw + mouse).
  _engage() {
    this._rawWrite(SEQ.enterAlt + SEQ.hideCursor + SEQ.mouseOn + SEQ.pasteOn);
    if (this._stdin.isTTY) {
      try { this._stdin.setRawMode(true); } catch { /* noop */ }
    }
    this._stdin.resume();
  }

  // Restore the terminal to its normal state. Safe to call repeatedly.
  _disengage() {
    if (this._stdin.isTTY) {
      try { this._stdin.setRawMode(false); } catch { /* noop */ }
    }
    this._rawWrite(SEQ.showCursor + SEQ.mouseOff + SEQ.pasteOff + SEQ.leaveAlt + SEQ.reset);
  }

  // ─── Public lifecycle ────────────────────────────────────────────────

  enter() {
    if (this._active) return;
    this._rawWrite = this._stdout.write.bind(this._stdout);
    this._active = true;
    this._suspended = false;
    this._engage();
    this._install();
  }

  leave() {
    if (!this._active) return;
    this._active = false;
    this._suspended = false;
    this._disengage();
    this._stdin.pause();
    this._uninstall();
  }

  // Ctrl+Z path: restore the terminal first, then actually stop the process
  // so the shell shows a clean prompt instead of raw mouse sequences.
  suspend(sig = 'SIGTSTP') {
    if (!this._active || this._suspended) return;
    this._suspended = true;
    this._disengage();
    this._stdin.pause();
    // Drop our stop handlers so the re-raised signal hits the default (stop)
    // disposition; SIGCONT stays registered so we can resume.
    this._removeStopHandlers();
    this._reRaise(sig);
  }

  // SIGCONT path: re-enter TUI mode and redraw.
  resume() {
    if (!this._active || !this._suspended) return;
    this._suspended = false;
    this._installStopHandlers();
    this._engage();
    try { this._onResume(); } catch { /* renderer errors must not break resume */ }
  }

  // ─── Signal wiring ───────────────────────────────────────────────────

  _install() {
    if (this._installed) return;
    this._installed = true;
    process.on('exit', this._exitHandler);
    process.on('uncaughtException', this._uncaughtHandler);
    for (const sig of TERM_SIGNALS) {
      try { process.on(sig, this._termHandlers[sig]); } catch { /* unsupported */ }
    }
    if (IS_POSIX) {
      try { process.on('SIGCONT', this._contHandler); } catch { /* noop */ }
      this._installStopHandlers();
    }
  }

  _uninstall() {
    if (!this._installed) return;
    this._installed = false;
    process.removeListener('exit', this._exitHandler);
    process.removeListener('uncaughtException', this._uncaughtHandler);
    for (const sig of TERM_SIGNALS) {
      try { process.removeListener(sig, this._termHandlers[sig]); } catch { /* noop */ }
    }
    if (IS_POSIX) {
      try { process.removeListener('SIGCONT', this._contHandler); } catch { /* noop */ }
      this._removeStopHandlers();
    }
  }

  _installStopHandlers() {
    if (!IS_POSIX) return;
    for (const sig of STOP_SIGNALS) {
      try { process.on(sig, this._stopHandlers[sig]); } catch { /* unsupported */ }
    }
  }

  _removeStopHandlers() {
    if (!IS_POSIX) return;
    for (const sig of STOP_SIGNALS) {
      try { process.removeListener(sig, this._stopHandlers[sig]); } catch { /* noop */ }
    }
  }

  _handleTerminate(sig) {
    this.leave();            // uninstalls every handler, including this one
    this._reRaise(sig);      // default disposition now terminates the process
  }

  _handleUncaught(err) {
    try { this.leave(); } catch { /* noop */ }
    try {
      const msg = err && err.stack ? err.stack : String(err);
      process.stderr.write(`\nFatal: ${msg}\n`);
    } catch { /* noop */ }
    process.exit(1);
  }
}

module.exports = { TerminalController, TERMINAL_SEQUENCES: SEQ };
