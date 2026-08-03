import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  PlusIcon,
  CloseIcon,
  TerminalIcon,
  ClaudeMarkIcon,
  OpenAIMarkIcon,
  OpenCodeMarkIcon,
  GeminiMarkIcon,
  PiMarkIcon,
} from '../ui/Icons.jsx';

// Left-rail panel: a real PTY on the open project (electron/terminal.js), for
// running a harness's full TUI — approvals, spinners and all — which the chat
// panel's one-shot JSON mode can't do.
//
// ponytail: one session per project, no tabs and no scrollback persistence.
// Upgrade path: a session list, if this ends up replacing the chat panel.

// xterm paints on a canvas, so it can't inherit the app's CSS: the theme is
// read out of the same custom properties the rest of the UI uses, once, at
// startup. The ANSI slots that have no token (magenta, cyan) are picked to sit
// with them rather than with xterm's defaults, which are far too saturated.
const token = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function appTheme() {
  const text = token('--text', '#f5f5f5');
  const dim = token('--text-dim', '#999999');
  const faint = token('--text-faint', '#666666');
  const accent = token('--accent', '#0099ff');
  const green = token('--component-green', '#79e09c');
  const red = token('--red', '#ff453a');
  const amber = token('--amber', '#ffd60a');
  return {
    background: token('--bg-panel', '#111111'),
    foreground: text,
    cursor: accent,
    cursorAccent: token('--bg-panel', '#111111'),
    selectionBackground: token('--accent-soft', 'rgba(0, 153, 255, 0.16)'),
    black: token('--bg', '#191919'),
    red,
    green,
    yellow: amber,
    blue: accent,
    magenta: '#c58af9',
    cyan: '#5bd6d6',
    white: dim,
    brightBlack: faint,
    brightRed: red,
    brightGreen: token('--green', '#30c158'),
    brightYellow: amber,
    brightBlue: '#4db8ff',
    brightMagenta: '#d9a8ff',
    brightCyan: '#7fe3e3',
    brightWhite: text,
  };
}
// One shell: an xterm bound to one PTY. Every open session stays mounted —
// unmounting kills the PTY, and with it whatever harness is running in it —
// so the inactive ones are only hidden.
function TerminalView({ id, cwd, command, visible, onRestart, onTitle }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const deadRef = useRef(false);

  useEffect(() => {
    if (!cwd || !hostRef.current) return;
    const term = new Terminal({
      fontFamily: token('--mono', "'SF Mono', Consolas, monospace"),
      fontSize: 12,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: appTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const offData = window.avb.onTermData(({ id: from, data }) => {
      if (from === id) term.write(data);
    });
    const offExit = window.avb.onTermExit(({ id: from, code }) => {
      if (from !== id) return;
      deadRef.current = true;
      term.write(`\r\n\x1b[90m[exited ${code}] \u2014 press Enter to start another\x1b[0m\r\n`);
    });
    // What the shell (or the harness) calls itself, via the OSC title escape
    // every terminal understands. Not every shell sends one — macOS's zsh only
    // does it for Terminal.app and iTerm — so the tab keeps its own name until
    // one arrives.
    term.onTitleChange((title) => onTitle?.(id, title));
    term.onData((data) => window.avb.writeTerm({ id, data }));
    // Once the shell is gone its keystrokes go nowhere, so Enter is free to
    // mean "run it again" — same harness, same cwd, fresh PTY.
    term.onKey(({ domEvent }) => {
      if (deadRef.current && domEvent.key === 'Enter') onRestart?.(id);
    });
    const claim = () => {
      focused.term = term;
    };
    hostRef.current.addEventListener('focusin', claim);

    // The PTY has to know the size before anything is written to it, or a TUI
    // lays itself out for the default 80x24 and never redraws.
    window.avb.openTerm({ id, cwd, command }).then(() => {
      fit.fit();
      window.avb.resizeTerm({ id, cols: term.cols, rows: term.rows });
    });

    return () => {
      offData();
      offExit();
      hostRef.current?.removeEventListener('focusin', claim);
      if (focused.term === term) focused.term = null;
      window.avb.closeTerm({ id });
      term.dispose();
      termRef.current = null;
    };
  }, [id, cwd, command]);

  // Refit when this session comes back into view, and while the panel is being
  // dragged. Hidden sessions sit this out: they measure as zero, and resizing
  // a PTY nobody is looking at only makes its TUI repaint. Dragging fires the
  // observer per frame, so the actual work is coalesced into one rAF — each
  // resize is an ioctl plus a full redraw at the other end.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !visible) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      const term = termRef.current;
      if (!term || !host.clientWidth) return;
      fitRef.current?.fit();
      window.avb.resizeTerm({ id, cols: term.cols, rows: term.rows });
    };
    sync();
    termRef.current?.focus();
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(sync);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [id, visible]);

  return (
    <div
      ref={hostRef}
      style={{ position: 'absolute', inset: 6, visibility: visible ? 'visible' : 'hidden' }}
    />
  );
}

// One mark per harness, monochrome like the rest of the UI's icons.
const MARK = {
  shell: TerminalIcon,
  claude: ClaudeMarkIcon,
  codex: OpenAIMarkIcon,
  pi: PiMarkIcon,
  opencode: OpenCodeMarkIcon,
  gemini: GeminiMarkIcon,
};

// The terminal that has the keyboard, for the app menu's Copy/Paste: on macOS
// the native menu eats ⌘C/⌘V before the page sees them, and xterm draws its
// selection on a canvas, so neither window.getSelection() nor webContents.copy()
// can find it. App.jsx asks here instead.
const focused = { term: null };

export const terminalClipboard = () => {
  const term = focused.term;
  if (!term || !document.activeElement?.closest('.xterm')) return null;
  return {
    copy: () => {
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text);
    },
    // Paste goes through the native command: it lands in xterm's hidden
    // textarea, whose paste handler feeds the PTY. Reading the clipboard from
    // the renderer would need a permission this app never asks for.
    paste: () => window.avb.nativePaste(),
  };
};

const Badge = ({ id }) => {
  const Icon = MARK[id] || TerminalIcon;
  return <Icon size={12} className="term-badge" />;
};

// The "+" popup: a plain shell, plus every coding CLI found on the PATH.
// Reuses the app's context-menu chrome rather than inventing a second one.
function ShellMenu({ pos, shells, onPick, onClose }) {
  useEffect(() => {
    const onDown = (e) => {
      if (!e.target.closest?.('.ctx-menu')) onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      style={{ left: Math.min(pos.left, window.innerWidth - 188), top: pos.top, width: 180 }}
    >
      {shells.map((s) => (
        <div key={s.id} className="ctx-menu-item" onClick={() => onPick(s)}>
          <span className="term-menu-label">
            <Badge id={s.id} />
            {s.name}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TerminalPanel({ project, active }) {
  const [sessions, setSessions] = useState([]); // [{ id, kind, name, command }]
  const [openId, setOpenId] = useState('');
  const [shells, setShells] = useState([]); // what's installed, from the main process
  const [menu, setMenu] = useState(null); // {left, top} of the "+" popup
  const [editId, setEditId] = useState(''); // tab being renamed
  const cancelRef = useRef(false); // Escape pressed, so the blur must not commit
  const seqRef = useRef(0);
  const openedRef = useRef(false); // has this project's panel opened a shell yet?

  useEffect(() => {
    window.avb.listTermShells().then(setShells);
  }, []);

  const addSession = (shell) => {
    const kind = shell?.id || 'shell';
    const id = `t${Date.now()}-${++seqRef.current}`;
    setSessions((list) => {
      // A second Claude Code is "Claude Code 2": three tabs with the same name
      // and the same mark are unusable.
      const same = list.filter((s) => s.kind === kind).length;
      const base = shell?.name || 'Shell';
      const name = same ? `${base} ${same + 1}` : base;
      return [...list, { id, kind, name, command: shell?.command || '' }];
    });
    setOpenId(id);
    setMenu(null);
  };

  // The last shell has no close button (see below), so this never empties the
  // panel.
  const closeSession = (id) => {
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (openId === id) setOpenId(next.at(-1)?.id || '');
  };

  // Three names per tab, in order: what the user typed, what the shell reports,
  // and the harness's own name. A manual rename wins for good — a title that
  // kept overwriting it would make renaming pointless.
  const label = (s) => s.custom || s.title || s.name;

  const rename = (id, value) => {
    const custom = value.trim();
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, custom } : s)));
    setEditId('');
  };

  // Shells re-announce their title constantly (every prompt, every command);
  // an unchanged one must not cost a render of the whole panel.
  const setTitle = (id, raw) => {
    const title = raw.trim();
    setSessions((list) =>
      list.some((s) => s.id === id && s.title !== title)
        ? list.map((s) => (s.id === id ? { ...s, title } : s))
        : list
    );
  };

  // Restarting is a new id: TerminalView keys off it, so the old xterm and its
  // dead PTY go and a fresh pair takes the same tab.
  const restartSession = (id) => {
    const fresh = `t${Date.now()}-${++seqRef.current}`;
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, id: fresh } : s)));
    setOpenId((open) => (open === id ? fresh : open));
  };

  // A different project means different shells; the old PTYs go with them.
  useEffect(() => {
    seqRef.current = 0;
    openedRef.current = false;
    setSessions([]);
    setOpenId('');
  }, [project?.path]);

  // No shell until the user actually opens the panel: every project would
  // otherwise pay for a login shell it never uses. Only the first visit opens
  // one, so an emptied panel stays empty.
  useEffect(() => {
    if (!active || openedRef.current || !project?.path) return;
    openedRef.current = true;
    addSession(null);
  }, [active, project?.path]);

  return (
    <div className="panel-section grow">
      <div className="term-tabs">
        {sessions.map((s) => (
          <span
            key={s.id}
            className={`term-tab ${s.id === openId ? 'on' : ''}`}
            onClick={() => setOpenId(s.id)}
          >
            <Badge id={s.kind} />
            {editId === s.id ? (
              <input
                className="term-tab-input"
                autoFocus
                defaultValue={label(s)}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  // Escape unmounts this input, which fires blur: without the
                  // flag, cancelling would commit the very edit it discards.
                  if (cancelRef.current) cancelRef.current = false;
                  else rename(s.id, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename(s.id, e.currentTarget.value);
                  else if (e.key === 'Escape') {
                    cancelRef.current = true;
                    setEditId('');
                  }
                }}
              />
            ) : (
              <span className="term-tab-name" onDoubleClick={() => setEditId(s.id)}>
                {label(s)}
              </span>
            )}
            {/* The lone shell can't be closed, but its ✕ still holds the space:
                dropping the node would make the tab jump a few pixels narrower. */}
            <button
              className={`ghost term-tab-x ${sessions.length > 1 ? '' : 'locked'}`}
              title="Close terminal"
              tabIndex={sessions.length > 1 ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        <button
          className="ghost term-add"
          title="New terminal"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu ? null : { left: r.left, top: r.bottom + 4 });
          }}
        >
          <PlusIcon size={13} />
        </button>
        {menu && (
          <ShellMenu
            pos={menu}
            shells={shells}
            onPick={addSession}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {sessions.map((s) => (
          <TerminalView
            key={s.id}
            id={s.id}
            cwd={project?.path}
            command={s.command}
            onRestart={restartSession}
            onTitle={setTitle}
            visible={active && s.id === openId}
          />
        ))}
      </div>
    </div>
  );
}
