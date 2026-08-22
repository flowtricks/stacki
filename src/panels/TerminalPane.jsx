import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { decideTerminalPaste, escapePosixPath, quoteWindowsPath } from '../terminalPaste.js';
import { ArrowDownIcon } from '../ui/Icons.jsx';

// One xterm instance bound to one pty. The dock owns the tabs; this owns a
// single pane's whole lifecycle.
//
// Ported from Meno (electron-app/src/components/TerminalPanel.tsx).

// Stacki is dark-only, so the palette is fixed rather than themed. Backgrounds
// track the dock's own surfaces (--bg-panel / --text) so the pane doesn't read
// as a foreign box dropped into the app.
const THEME = {
  background: '#111111',
  foreground: '#f5f5f5',
  cursor: '#f5f5f5',
  cursorAccent: '#111111',
  selectionBackground: 'rgba(0, 153, 255, 0.30)',
  black: '#3f3f3f',
  red: '#ff453a',
  green: '#30c158',
  yellow: '#ffd60a',
  blue: '#0099ff',
  magenta: '#bf5af2',
  cyan: '#5ac8fa',
  white: '#d4d4d4',
  brightBlack: '#6b6b6b',
  brightRed: '#ff6961',
  brightGreen: '#63d97f',
  brightYellow: '#ffe45c',
  brightBlue: '#4db8ff',
  brightMagenta: '#d68cf5',
  brightCyan: '#8adcfb',
  brightWhite: '#ffffff',
};

const isWindows = () => window.avb.platform === 'win32';
const isMac = () => window.avb.platform === 'darwin';

const TerminalPane = forwardRef(function TerminalPane(
  { terminalId, projectPath, autoLaunch, onTitleChange },
  ref
) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const initialized = useRef(false);
  const ready = useRef(false);
  // Removes this pane's IPC listeners on unmount. Held in a ref because init
  // can run later, from the ResizeObserver.
  const disposeListeners = useRef(null);
  // Read from a ref rather than the closure: the init effect owns the pty's
  // entire lifecycle, so making these callbacks dependencies of it would kill
  // and respawn the user's shell on every parent re-render.
  const onTitleChangeRef = useRef(onTitleChange);
  const autoLaunchRef = useRef(autoLaunch);
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
    autoLaunchRef.current = autoLaunch;
  });

  const [scrolledUp, setScrolledUp] = useState(false);

  // Fitting a zero-sized or half-built terminal throws from deep inside
  // xterm's viewport, so every fit goes through here.
  const safeFit = () => {
    if (!ready.current || !fitRef.current || !termRef.current || !hostRef.current) return;
    const { offsetWidth, offsetHeight } = hostRef.current;
    if (offsetWidth === 0 || offsetHeight === 0) return;
    try {
      fitRef.current.fit();
      const dims = fitRef.current.proposeDimensions();
      if (dims?.cols && dims?.rows) {
        window.avb.resizeTerminal({ id: terminalId, cols: dims.cols, rows: dims.rows });
      }
    } catch {
      /* not fully rendered yet */
    }
  };

  useImperativeHandle(ref, () => ({
    fit: safeFit,
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    // Reset the lifecycle flags for THIS run. They're refs, so they outlive the
    // effect — but the cleanup below tears the terminal down completely, so a
    // re-run has to start from scratch rather than inherit the previous run's
    // state. Carrying them over leaves the pane permanently blank.
    initialized.current = false;
    ready.current = false;
    // Per-run teardown token. The refs above are shared, so a callback left
    // over from an earlier run (a queued RAF, an in-flight IPC message) would
    // read the *current* run's flags and act on a terminal it doesn't own.
    let runDisposed = false;

    // --- Paste & drop ----------------------------------------------------
    // xterm's built-in paste is text-only; decideTerminalPaste classifies the
    // clipboard's actual shape. See src/terminalPaste.js.
    const pasteImage = async (file) => {
      const forwardCtrlV = () => window.avb.terminalInput(terminalId, '\x16');
      if (!file) return forwardCtrlV();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await window.avb.terminalClipboardImage(bytes, file.type || 'image/png');
        if (!result?.ok || !result.path) return forwardCtrlV();
        const escaped = isWindows()
          ? quoteWindowsPath(result.path)
          : escapePosixPath(result.path);
        // paste() applies bracketed-paste wrapping when the foreground program
        // enabled it, matching a native drag-drop of the same path.
        termRef.current?.paste(escaped);
      } catch {
        forwardCtrlV();
      }
    };

    const onPaste = (e) => {
      const data = e.clipboardData;
      if (!data) return;
      const action = decideTerminalPaste(
        Array.from(data.items),
        data.getData('text/plain'),
        window.avb.getFilePath,
        isWindows()
      );
      if (action.kind === 'text') return; // xterm handles it
      // Capture phase + stopImmediatePropagation runs ahead of xterm's own
      // textarea paste listener, so its text-only path never fires.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (action.kind === 'paths') termRef.current?.paste(action.text);
      else void pasteImage(action.file);
    };

    // Dropping a file onto a native terminal inserts its escaped path;
    // Electron's default is to navigate the window to the file, so without
    // these a drop does nothing useful. dragover must preventDefault for the
    // drop event to fire at all.
    const onDragOver = (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      const data = e.dataTransfer;
      if (!data) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const action = decideTerminalPaste(
        Array.from(data.items),
        data.getData('text/plain'),
        window.avb.getFilePath,
        isWindows()
      );
      if (action.kind === 'paths') termRef.current?.paste(action.text);
      else if (action.kind === 'image') void pasteImage(action.file);
      else {
        // Dropped text has no xterm fallback (unlike paste) — insert it here.
        const text = data.getData('text/plain');
        if (text) termRef.current?.paste(text);
      }
    };

    // ⌘⇧V / Ctrl+Shift+V — the other paste binding terminals answer to. ⌘V
    // arrives as a real paste event (the app menu routes it to the focused
    // xterm textarea via webContents.paste), but nothing claims the shifted
    // form, so xterm would just send the keystroke to the pty. Asking main to
    // paste turns it into that same native paste event, so onPaste above sees
    // the full clipboard and images/paths behave identically to ⌘V.
    const onKeyDown = (e) => {
      const wantsPaste = isMac()
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if (!wantsPaste || e.key.toLowerCase() !== 'v') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.avb.nativePaste();
    };

    host.addEventListener('keydown', onKeyDown, true);
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('dragover', onDragOver, true);
    host.addEventListener('drop', onDrop, true);

    const init = () => {
      if (initialized.current) return;
      // Wait for the host to have dimensions — the dock starts collapsed.
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      initialized.current = true;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: "'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
        theme: THEME,
        // Bounded on purpose: xterm holds every scrollback line in memory and
        // only trims at this limit, so an unbounded value means a long-running
        // watcher or agent grows the buffer until the renderer bogs down.
        scrollback: 10_000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      termRef.current = term;
      fitRef.current = fit;

      try {
        term.open(host);
        // xterm's render service finishes initializing after a paint frame;
        // fitting before that throws from Viewport._innerRefresh. The double
        // RAF waits it out, then unlocks fits.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (runDisposed) return;
            ready.current = true;
            safeFit();
            term.focus();
          })
        );
      } catch {
        /* open failed — the error path below still reports */
      }

      term.onData((data) => window.avb.terminalInput(terminalId, data));

      // Title set by the foreground program via an OSC 0/2 sequence. Shells
      // that do this re-emit on every prompt, so the dock drops repeats rather
      // than re-rendering the tab bar.
      term.onTitleChange((title) => {
        if (!runDisposed) onTitleChangeRef.current?.(title);
      });

      // Show the scroll-to-bottom button when the user has scrolled up. Uses
      // the buffer API rather than measuring `.xterm-viewport`: v6 reworked
      // those internals, so reading its DOM couples us to markup free to
      // change. viewportY is the top line on screen; baseY is that value when
      // pinned to the bottom. ~2 lines of slack keeps it from flickering when
      // a line lands mid-scroll.
      term.onScroll(() => {
        const buf = term.buffer.active;
        setScrolledUp(buf.baseY - buf.viewportY > 2);
      });

      const offData = window.avb.onTerminalData(({ id, data }) => {
        if (id !== terminalId || runDisposed || !termRef.current) return;
        try {
          // The write callback fires once xterm has actually parsed this chunk,
          // so acking from here reports real render progress and lets main
          // pause the pty when we fall behind (see electron/terminal.js flow
          // control). Without it a fast writer outruns the renderer and the UI
          // locks up.
          termRef.current.write(data, () => window.avb.terminalAck(terminalId, data.length));
        } catch {
          /* disposed mid-write */
        }
      });
      const offExit = window.avb.onTerminalExit(({ id, exitCode }) => {
        if (id !== terminalId || runDisposed || !termRef.current) return;
        termRef.current.write(
          `\r\n\x1b[90m[process exited${exitCode ? ` with code ${exitCode}` : ''}]\x1b[0m\r\n`
        );
      });
      disposeListeners.current = () => {
        offData();
        offExit();
      };

      window.avb
        .startTerminal({ id: terminalId, cwd: projectPath, autoLaunch: autoLaunchRef.current })
        .then((result) => {
          if (!result?.ok && result?.error) {
            term.writeln(`\r\n\x1b[31m${result.error}\x1b[0m\r\n`);
          }
        })
        .catch((err) => {
          // The IPC handler rejected outright. Without this the failure is
          // swallowed and the pane just stays blank — no prompt, no error.
          term.writeln(`\r\n\x1b[31mFailed to start terminal: ${err?.message || err}\x1b[0m\r\n`);
        });
    };

    // The dock is hidden until toggled, so the host has no size on mount —
    // the observer is what actually starts the terminal, first time round.
    const ro = new ResizeObserver(() => (initialized.current ? safeFit() : init()));
    ro.observe(host);
    init(); // …unless it's already visible

    const onWindowResize = () => safeFit();
    window.addEventListener('resize', onWindowResize);

    return () => {
      runDisposed = true;
      ready.current = false;
      ro.disconnect();
      // Drop the IPC listeners; otherwise every open/close leaks a pair that
      // pins this disposed terminal in their closures.
      disposeListeners.current?.();
      disposeListeners.current = null;
      host.removeEventListener('keydown', onKeyDown, true);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('dragover', onDragOver, true);
      host.removeEventListener('drop', onDrop, true);
      window.removeEventListener('resize', onWindowResize);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [terminalId, projectPath]);

  return (
    <div className="term-pane">
      <div className="term-host" ref={hostRef} />
      {scrolledUp && (
        <button
          className="term-scroll-btn"
          title="Scroll to bottom"
          onClick={() => termRef.current?.scrollToBottom()}
        >
          <ArrowDownIcon size={14} />
        </button>
      )}
    </div>
  );
});

export default TerminalPane;
