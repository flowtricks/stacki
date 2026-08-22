import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import TerminalPane from './TerminalPane.jsx';
import Dropdown from '../ui/Dropdown.jsx';
import { PlusIcon, CloseIcon, ChevronDownIcon } from '../ui/Icons.jsx';

// The bottom terminal dock: tab bar, drag-to-resize top edge, one pty per tab.
//
// Stacki can't anticipate the toolchain of a project it didn't create — the
// package manager, the test runner, the coding agent — so rather than guessing
// at each, it hands over the shell you already have, already in the project.
//
// Ported from Meno's TabbedTerminal, with its zustand store replaced by local
// state and its per-project keying dropped: Stacki has one project open at a
// time, so a project switch retires the dock's terminals instead.

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 280;
// Leave the canvas usable however hard the handle is dragged.
const MIN_TOP_GAP = 180;

const HEIGHT_KEY = 'stacki.terminal.height';
const MODE_KEY = 'stacki.terminal.autoLaunch';
const CUSTOM_KEY = 'stacki.terminal.autoLaunchCustom';

const AUTO_LAUNCH_OPTIONS = [
  { value: 'none', label: 'Shell only' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'custom', label: 'Custom…' },
];

const readStored = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the setting just won't persist */
  }
};

// --- Tab labels ------------------------------------------------------------

const MAX_LABEL = 22;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Login shells are invoked as `-zsh`; the dash isn't part of the name.
const stripLoginDash = (name) => (name.startsWith('-') ? name.slice(1) : name);

// A label that is only a path (no spaces) is almost always the cwd —
// oh-my-zsh's default title is the truncated cwd. Its tail is the useful part
// but truncation keeps the head, so collapse it to the basename first. Titles
// with spaces ("feat: split a/b") are left alone.
const shortenPathLike = (label) => {
  if (/\s/.test(label) || !label.includes('/')) return label;
  const parts = label.split('/').filter(Boolean);
  return parts[parts.length - 1] || label;
};

function cleanLabel(raw) {
  // Flatten the whitespace a multi-line or padded title would otherwise carry
  // into the tab bar. Control chars become spaces rather than being dropped —
  // deleting the newline in 'build\nfinished' would read as 'buildfinished'.
  const flat = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const short = shortenPathLike(flat);
  return short.length <= MAX_LABEL ? short : `${short.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}

// What a tab shows, in preference order: the OSC title the foreground program
// set, else the pty's foreground process name, else its 1-based position.
//
// The number is a real fallback, not a legacy path: a plain login zsh emits no
// OSC title at all (macOS's /etc/zshrc gates its title hook on
// TERM_PROGRAM=Apple_Terminal, and main reports 'stacki'), and the process name
// only arrives once main has polled the pty.
export function tabLabel(tab, index) {
  return cleanLabel(tab.oscTitle || stripLoginDash(tab.processName)) || `${index + 1}`;
}

// Four shells all report "zsh", which makes the tab bar useless for telling
// them apart — so a label that isn't unique gets its position appended. Tabs
// whose foreground program named itself keep the name alone.
export function tabLabels(tabs) {
  const raw = tabs.map(tabLabel);
  const counts = new Map();
  for (const label of raw) counts.set(label, (counts.get(label) || 0) + 1);
  return raw.map((label, i) => (counts.get(label) > 1 ? `${label} ${i + 1}` : label));
}

// ---------------------------------------------------------------------------

export default function TerminalDock({ projectPath, open, onClose }) {
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const nextNumber = useRef(1);
  // The project-switch cleanup below has to see the tabs as they are when it
  // runs, not as they were on the render that registered it.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const [height, setHeight] = useState(() => {
    const stored = parseInt(readStored(HEIGHT_KEY, ''), 10);
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
  });
  const [dragging, setDragging] = useState(false);

  const [mode, setMode] = useState(() => readStored(MODE_KEY, 'none'));
  const [custom, setCustom] = useState(() => readStored(CUSTOM_KEY, ''));

  const paneRefs = useRef(new Map());

  // What a new tab runs once its shell settles. Read when the pty starts, so
  // changing it affects the next terminal rather than the ones already open.
  const autoLaunch =
    mode === 'claude' ? 'claude' : mode === 'codex' ? 'codex' : mode === 'custom' ? custom : '';

  const createTab = useCallback(() => {
    const id = `${projectPath}:term-${nextNumber.current++}`;
    setTabs((prev) => [...prev, { id, oscTitle: '', processName: '' }]);
    setActiveId(id);
  }, [projectPath]);

  const closeTab = useCallback(
    (id) => {
      window.avb.closeTerminal({ id });
      paneRefs.current.delete(id);
      const index = tabs.findIndex((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      // Fall through to whichever tab slid into the closed one's place.
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
    },
    [tabs, activeId]
  );

  // A project switch retires every pty: the ids are keyed to the old path, and
  // the shells sit in a directory the app no longer has open.
  const seeded = useRef(false);
  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) window.avb.closeTerminal({ id: tab.id });
      paneRefs.current.clear();
      nextNumber.current = 1;
      seeded.current = false;
      setTabs([]);
      setActiveId(null);
    };
  }, [projectPath]);

  // Open with one terminal ready. The `seeded` guard rather than `tabs.length`
  // alone: React 18's StrictMode remounts effects before the first setState has
  // flushed, so a length check on its own opens a second, redundant shell.
  useEffect(() => {
    if (!open || seeded.current) return;
    seeded.current = true;
    createTab();
  }, [open, createTab]);

  // Foreground process name for every pty, pushed by main only when it changes
  // — one listener for the whole dock rather than one per pane.
  useEffect(() => {
    return window.avb.onTerminalProcess(({ id, name }) => {
      setTabs((prev) =>
        prev.some((t) => t.id === id && t.processName !== name)
          ? prev.map((t) => (t.id === id ? { ...t, processName: name } : t))
          : prev
      );
    });
  }, []);

  const setTabTitle = useCallback((id, oscTitle) => {
    // A shell re-emits its OSC title on every prompt; bail on repeats rather
    // than re-rendering the whole tab bar for nothing.
    setTabs((prev) =>
      prev.some((t) => t.id === id && t.oscTitle !== oscTitle)
        ? prev.map((t) => (t.id === id ? { ...t, oscTitle } : t))
        : prev
    );
  }, []);

  // --- Resize ------------------------------------------------------------

  const onHandleDown = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - MIN_TOP_GAP);
    setDragging(true);

    // Dragging up (a smaller clientY) makes the dock taller.
    const onMove = (ev) =>
      setHeight(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY))));
    const onUp = (ev) => {
      onMove(ev);
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      store(
        HEIGHT_KEY,
        String(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY))))
      );
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Re-fit the visible terminal whenever the space it has changes. Each pane
  // carries its own ResizeObserver, but a tab switch reveals one that was
  // display:none and so never saw the resize — this covers that.
  useLayoutEffect(() => {
    if (!open || !activeId) return;
    const pane = paneRefs.current.get(activeId);
    // A frame's grace, so the pane has its final size before it measures.
    const raf = requestAnimationFrame(() => {
      pane?.fit();
      pane?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, activeId, height]);

  const setPaneRef = useCallback((id, ref) => {
    if (ref) paneRefs.current.set(id, ref);
    else paneRefs.current.delete(id);
  }, []);

  const labels = tabLabels(tabs);

  return (
    // Kept mounted while hidden: unmounting disposes every xterm and loses the
    // scrollback, so toggling the dock would wipe whatever was on screen.
    <div className={`term-dock ${open ? 'on' : ''}`} style={{ height: open ? height : 0 }}>
      <div
        className={`term-resize ${dragging ? 'on' : ''}`}
        onPointerDown={onHandleDown}
        title="Drag to resize"
      />

      <div className="term-bar">
        <div className="term-tabs">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              className={`term-tab ${tab.id === activeId ? 'on' : ''}`}
              onClick={() => setActiveId(tab.id)}
              title={tab.oscTitle || tab.processName || undefined}
            >
              <span className="term-tab-label">{labels[i]}</span>
              {tabs.length > 1 && (
                <span
                  className="term-tab-x"
                  title="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <CloseIcon size={10} />
                </span>
              )}
            </button>
          ))}
          <button className="ghost term-add" title="New terminal" onClick={createTab}>
            <PlusIcon size={13} />
          </button>
        </div>

        <div className="term-bar-right">
          {mode === 'custom' && (
            <input
              className="term-custom"
              value={custom}
              placeholder="e.g. bun run watch"
              title="Run once in each new terminal"
              onChange={(e) => {
                setCustom(e.target.value);
                store(CUSTOM_KEY, e.target.value);
              }}
            />
          )}
          <Dropdown
            className="term-launch"
            value={mode}
            options={AUTO_LAUNCH_OPTIONS}
            livePreview={false}
            onChange={(v) => {
              setMode(v);
              store(MODE_KEY, v);
            }}
          />
          <button className="ghost" title="Hide terminal (⌘J)" onClick={onClose}>
            <ChevronDownIcon size={13} />
          </button>
        </div>
      </div>

      <div className="term-panes">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="term-pane-wrap"
            style={{ display: tab.id === activeId ? 'block' : 'none' }}
          >
            <TerminalPane
              ref={(ref) => setPaneRef(tab.id, ref)}
              terminalId={tab.id}
              projectPath={projectPath}
              autoLaunch={autoLaunch}
              onTitleChange={(title) => setTabTitle(tab.id, title)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
